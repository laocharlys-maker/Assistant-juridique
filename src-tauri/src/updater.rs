// Auto-update (Lot 8). Verifie une nouvelle version au demarrage et
// demande TOUJOURS une confirmation explicite avant tout telechargement/
// installation - jamais de mise a jour silencieuse (voir README-LOT8.md).
//
// Choix technique : geree entierement cote Rust (verification + boite de
// dialogue native de confirmation via tauri-plugin-dialog), plutot que via
// l'API JS du plugin updater. La fenetre principale d'Aurore affiche une
// page web sservie par le sidecar (http://127.0.0.1:PORT), pas les assets
// empaquetes par Tauri lui-meme - dans cet environnement de developpement
// (sans Rust/Tauri CLI installes, voir README-LOT1.md), impossible de
// verifier que le pont IPC/JS de Tauri (window.__TAURI__) reste bien
// injecte dans ce contexte. Le chemin 100% Rust ci-dessous ne depend
// d'aucune hypothese de ce genre.
//
// IMPORTANT (voir README-LOT8.md) : ce fichier n'a pas pu etre compile ni
// teste dans cet environnement (pas de Rust/Cargo disponible). Ecrit en
// suivant precisement l'API documentee de tauri-plugin-updater v2 et
// tauri-plugin-dialog v2, a valider au premier vrai build.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Lance une verification de mise a jour en arriere-plan. A appeler une
/// fois l'application demarree (voir main.rs) - jamais bloquant pour le
/// demarrage normal : une erreur reseau ici (pas d'internet, endpoint de
/// mise a jour injoignable) est journalisee et silencieusement ignoree,
/// l'application continue de fonctionner normalement hors-ligne.
///
/// REACTIVEE le 2026-09-11 (avait ete mise en veilleuse le 2026-09-02) -
/// voir le commentaire pres de l'appel dans main.rs. Ne fonctionne
/// concretement que si la version (tauri.conf.json/Cargo.toml/package.json)
/// est de nouveau incrementee a chaque build - sinon `updater.check()`
/// ne trouve jamais de version plus recente que la sienne.
pub fn check_for_updates(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(err) => {
                eprintln!("[updater] impossible d'initialiser le verificateur de mise a jour : {err}");
                return;
            }
        };

        let update = match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => {
                println!("[updater] aucune mise a jour disponible (deja a jour).");
                return;
            }
            Err(err) => {
                // Cas normal si le poste n'a pas d'acces internet (cabinet
                // en mode purement local) - jamais une erreur bloquante.
                println!("[updater] verification de mise a jour impossible (ignore) : {err}");
                return;
            }
        };

        let version = update.version.clone();
        println!("[updater] nouvelle version disponible : {version}");

        let message = format!(
            "Une nouvelle version d'Aurore est disponible (v{version}).\n\nVoulez-vous l'installer maintenant ? L'application redemarrera automatiquement une fois la mise a jour terminee.\n\nVous pouvez aussi continuer avec la version actuelle et le redemander plus tard."
        );

        // Boite de dialogue native Oui/Non - c'est ICI, et seulement ici,
        // que l'utilisateur donne (ou refuse) son consentement explicite.
        // Rien n'est telecharge avant cette confirmation.
        let app_for_callback = app.clone();
        app.dialog()
            .message(message)
            .title("Mise à jour Aurore disponible")
            .buttons(MessageDialogButtons::YesNo)
            .kind(MessageDialogKind::Info)
            .show(move |confirmed| {
                if !confirmed {
                    println!("[updater] mise a jour refusee par l'utilisateur - proposee de nouveau au prochain demarrage.");
                    return;
                }
                let app_handle = app_for_callback.clone();
                tauri::async_runtime::spawn(async move {
                    println!("[updater] telechargement et installation de la mise a jour...");
                    // Barre de progression visible cote frontend (voir public/js/api.js,
                    // ecouteurs "aurore-update-*") - avant ce correctif, rien ne
                    // s'affichait pendant le telechargement/installation (~85 Mo), ce qui
                    // donnait l'impression que la mise a jour ne faisait rien du tout.
                    let _ = app_handle.emit("aurore-update-start", ());
                    let telecharge = Arc::new(AtomicU64::new(0));
                    let telecharge_pour_callback = telecharge.clone();
                    // Dernier pourcentage deja emis - evite d'appeler emit() a CHAQUE
                    // morceau recu (potentiellement des milliers pour ~85 Mo, un par
                    // segment TCP/HTTP) : un emit() par pourcentage uniquement, bien
                    // assez fluide pour une barre de progression visuelle, et qui ne
                    // risque plus de ralentir la lecture du flux HTTP sous-jacent en
                    // la bloquant trop souvent sur l'IPC vers la fenetre.
                    let dernier_pourcentage = Arc::new(AtomicU64::new(u64::MAX));
                    let app_handle_pour_progres = app_handle.clone();
                    let app_handle_pour_installation = app_handle.clone();
                    let install_result = update
                        .download_and_install(
                            move |chunk_length, content_length| {
                                let total = telecharge_pour_callback
                                    .fetch_add(chunk_length as u64, Ordering::SeqCst)
                                    + chunk_length as u64;
                                let pourcentage = match content_length {
                                    Some(longueur_totale) if longueur_totale > 0 => {
                                        (total.min(longueur_totale) * 100) / longueur_totale
                                    }
                                    _ => 0,
                                };
                                if dernier_pourcentage.swap(pourcentage, Ordering::SeqCst) != pourcentage {
                                    let _ = app_handle_pour_progres.emit(
                                        "aurore-update-progress",
                                        serde_json::json!({ "downloaded": total, "total": content_length }),
                                    );
                                }
                            },
                            move || {
                                println!("[updater] telechargement termine, installation en cours...");
                                let _ = app_handle_pour_installation.emit("aurore-update-installing", ());
                            },
                        )
                        .await;

                    match install_result {
                        Ok(()) => {
                            println!("[updater] mise a jour installee - redemarrage de l'application.");
                            app_handle.restart();
                        }
                        Err(err) => {
                            eprintln!("[updater] echec de la mise a jour : {err}");
                            let _ = app_handle.emit("aurore-update-error", ());
                            app_handle
                                .dialog()
                                .message(format!(
                                    "La mise a jour n'a pas pu etre installee ({err}). Aurore continue de fonctionner normalement avec la version actuelle."
                                ))
                                .title("Échec de la mise à jour")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                        }
                    }
                });
            });
    });
}
