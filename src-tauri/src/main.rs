// Coquille desktop Tauri pour Aurore.
//
// Ce fichier est volontairement minimal et ne contient aucune logique
// metier : il se contente de gerer le cycle de vie du sidecar backend
// (demarrage, health-check, arret propre) et d'afficher son interface dans
// la fenetre principale. Toute la logique applicative reste dans le
// backend Express/TS existant (voir ../backend).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

mod updater;

/// Nom declare dans `bundle.externalBin` de tauri.conf.json (sans le
/// suffixe de target triple, ajoute automatiquement par Tauri).
const SIDECAR_NAME: &str = "aurore-backend";
const BACKEND_PORT: u16 = 3000;
const HEALTH_CHECK_MAX_ATTEMPTS: u32 = 60;
const HEALTH_CHECK_INTERVAL_MS: u64 = 500;
/// Delai laisse au sidecar pour fermer proprement ses connexions Prisma PUIS
/// (Lot 2, DATABASE_MODE=portable) arreter le cluster Postgres portable
/// (`pg_ctl stop -m fast`) apres reception de la commande d'arret, avant un
/// kill forcé en dernier recours. Mesure empiriquement pendant le
/// developpement du Lot 2 : la chaine complete (fermeture HTTP + Prisma +
/// pg_ctl stop) prend couramment 3 a 4 secondes a elle seule - la marge
/// ci-dessous est volontairement large pour un PC plus lent ou une base plus
/// grosse.
const SHUTDOWN_GRACE_MS: u64 = 10000;

struct SidecarState(Mutex<Option<CommandChild>>);

fn health_url() -> String {
    format!("http://127.0.0.1:{BACKEND_PORT}/health")
}

fn app_url() -> String {
    format!("http://127.0.0.1:{BACKEND_PORT}/")
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // Dossier de ressources ou tauri.conf.json (bundle.resources) a
            // copie public/, node_modules/ (client Prisma + pdfkit),
            // postgres/ (binaires Postgres portables + pgvector, Lot 2) et
            // prisma/ (portable-init.sql) issus de backend/dist-sea/ - voir
            // scripts/build-sea.js pour le detail de ce qui y est place et
            // pourquoi.
            let resource_dir = handle
                .path()
                .resource_dir()
                .expect("impossible de resoudre le dossier de ressources Tauri");

            println!("[aurore] demarrage du sidecar backend (ressources: {resource_dir:?})...");

            let shell = handle.shell();
            let (mut rx, child) = shell
                .sidecar(SIDECAR_NAME)
                .expect("sidecar 'aurore-backend' introuvable - as-tu lance `npm run tauri:build`/`tauri:dev` (qui prepare le binaire) plutot que `tauri build` directement ?")
                // Le sidecar lit AURORE_APP_ROOT pour localiser public/,
                // node_modules/ et postgres/ (voir backend/src/lib/seaPaths.ts
                // et backend/src/database/portablePaths.ts) - sans cela il
                // retomberait sur le dossier de l'executable, qui ne
                // correspond pas forcement a resource_dir() une fois installe.
                .env("AURORE_APP_ROOT", resource_dir.to_string_lossy().to_string())
                .env("HOST", "127.0.0.1")
                .env("PORT", BACKEND_PORT.to_string())
                // La coquille desktop est TOUJOURS en mode standalone/local
                // (Lot 2) : Postgres portable est initialise/demarre par le
                // sidecar lui-meme, jamais une DATABASE_URL de VPS.
                .env("DATABASE_MODE", "portable")
                .spawn()
                .expect("echec du lancement du sidecar backend");

            *handle.state::<SidecarState>().0.lock().unwrap() = Some(child);

            // Relaie stdout/stderr du sidecar vers la console Tauri (utile
            // en mode dev pour suivre demarrage -> health-check -> pret).
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            println!("[backend] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[backend] erreur sidecar : {err}");
                        }
                        CommandEvent::Terminated(payload) => {
                            println!("[backend] sidecar termine : {payload:?}");
                        }
                        _ => {}
                    }
                }
            });

            // Poll /health en tache de fond ; la fenetre reste sur l'ecran
            // de chargement (loading/index.html) jusqu'a reponse OK, evitant
            // le splash blanc d'une webview pointee directement sur un
            // serveur pas encore pret.
            let window = app
                .get_webview_window("main")
                .expect("fenetre principale 'main' introuvable");

            let handle_for_updater = handle.clone();
            std::thread::spawn(move || {
                let health_url = health_url();
                println!("[aurore] attente du health-check ({health_url})...");
                for attempt in 1..=HEALTH_CHECK_MAX_ATTEMPTS {
                    match ureq::get(&health_url).timeout(Duration::from_secs(2)).call() {
                        Ok(response) if response.status() < 500 => {
                            println!(
                                "[aurore] health-check OK (tentative {attempt}/{HEALTH_CHECK_MAX_ATTEMPTS}), chargement de l'interface."
                            );
                            let script = format!("window.location.replace({:?});", app_url());
                            let _ = window.eval(&script);
                            // Verification de mise a jour (Lot 8) : lancee une
                            // fois l'application reellement utilisable, jamais
                            // avant - ne bloque jamais le demarrage normal (voir
                            // updater.rs, entierement non-bloquant/best-effort).
                            updater::check_for_updates(handle_for_updater);
                            return;
                        }
                        Ok(response) => {
                            println!(
                                "[aurore] health-check {attempt}/{HEALTH_CHECK_MAX_ATTEMPTS} : statut {}",
                                response.status()
                            );
                        }
                        Err(err) => {
                            println!(
                                "[aurore] health-check {attempt}/{HEALTH_CHECK_MAX_ATTEMPTS} : {err}"
                            );
                        }
                    }
                    std::thread::sleep(Duration::from_millis(HEALTH_CHECK_INTERVAL_MS));
                }
                eprintln!(
                    "[aurore] le backend n'a pas repondu apres {HEALTH_CHECK_MAX_ATTEMPTS} tentatives - le sidecar a-t-il demarre correctement ? (voir les logs [backend] ci-dessus)"
                );
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<SidecarState>();
                let mut guard = state.0.lock().unwrap();
                if let Some(mut child) = guard.take() {
                    println!("[aurore] arret du sidecar backend (signal propre via stdin)...");
                    // Windows ne propage pas SIGTERM de facon fiable a un
                    // process enfant : on utilise donc un signal applicatif
                    // simple (voir backend/src/index.ts) plutot qu'un kill
                    // direct, pour laisser Prisma fermer ses connexions.
                    if child.write(b"shutdown\n").is_err() {
                        eprintln!("[aurore] impossible d'ecrire sur stdin du sidecar, arret forcé.");
                    } else {
                        std::thread::sleep(Duration::from_millis(SHUTDOWN_GRACE_MS));
                    }
                    // Filet de securite si le sidecar n'a pas quitte de
                    // lui-meme dans le delai imparti.
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
