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

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Lance une verification de mise a jour en arriere-plan. A appeler une
/// fois l'application demarree (voir main.rs) - jamais bloquant pour le
/// demarrage normal : une erreur reseau ici (pas d'internet, endpoint de
/// mise a jour injoignable) est journalisee et silencieusement ignoree,
/// l'application continue de fonctionner normalement hors-ligne.
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
                    let install_result = update
                        .download_and_install(
                            |_chunk_length, _content_length| {
                                // Progression du telechargement - pas de barre de
                                // progression dediee pour ce lot, le journal
                                // suffit (voir README-LOT8.md, ameliorations
                                // possibles).
                            },
                            || {
                                println!("[updater] telechargement termine, installation en cours...");
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
