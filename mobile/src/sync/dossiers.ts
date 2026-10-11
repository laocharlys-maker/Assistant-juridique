import { envoyerRequeteAuthentifiee } from "../pairing/appareil";
import { remplacerCacheDossiers, type DossierCache } from "../storage/db";

/**
 * Rafraîchit le cache local des dossiers/prochaines audiences depuis Aurore
 * (Prompt 6, objectif D : "à chaque synchronisation réussie") - factorisé
 * ici pour être appelé aussi bien depuis l'écran "Mes dossiers" (Prompt 3)
 * que depuis sync/elements.ts après un envoi ou une confirmation réussis.
 * Jamais une erreur bloquante : la dernière liste connue reste affichée.
 */
export async function synchroniserDossiers(): Promise<boolean> {
  try {
    const recus = await envoyerRequeteAuthentifiee<DossierCache[]>("/api/m/dossiers", {});
    await remplacerCacheDossiers(recus);
    return true;
  } catch {
    return false;
  }
}
