import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

/**
 * Journal d'erreurs local (Prompt 7, objectif B) - "sans contenu,
 * exportable à la main par l'utilisateur pour le support". Chaque ligne
 * est un message GÉNÉRIQUE déjà utilisé pour l'affichage à l'écran
 * (ex. "Aurore introuvable sur ce réseau", "Appareil révoqué...") - jamais
 * de texte de note, jamais un extrait d'audio/scan, jamais une adresse IP
 * complète ni un identifiant d'appareil. Fichier en clair (jamais chiffré
 * par le coffre applicatif) car son contenu est, par construction, non
 * confidentiel - c'est justement ce qui permet de l'exporter simplement.
 */

const NOM_FICHIER = "journal-erreurs.ndjson";
const NOMBRE_LIGNES_MAX = 500;

interface LigneJournal {
  horodatage: string;
  contexte: string;
  message: string;
}

function fichierJournal(): File {
  return new File(Paths.document, NOM_FICHIER);
}

async function lireLignes(): Promise<string[]> {
  const fichier = fichierJournal();
  if (!fichier.exists) return [];
  const contenu = await fichier.text();
  return contenu.split("\n").filter((ligne) => ligne.trim().length > 0);
}

/** Consigne une erreur déjà réduite à un message générique (voir
 * l'appelant) - ne lève jamais d'exception elle-même : un échec de
 * journalisation ne doit jamais faire échouer l'action qui a déclenché le
 * log. */
export async function consignerErreur(contexte: string, message: string): Promise<void> {
  try {
    const ligne: LigneJournal = { horodatage: new Date().toISOString(), contexte, message };
    const lignes = await lireLignes();
    lignes.push(JSON.stringify(ligne));
    // Plafonne pour ne jamais grossir indefiniment (usage prevu : support
    // ponctuel, pas une telemetrie continue) - garde les plus recentes.
    const conservees = lignes.slice(-NOMBRE_LIGNES_MAX);
    const dossier = new Directory(Paths.document);
    dossier.create({ idempotent: true });
    fichierJournal().write(conservees.join("\n") + "\n");
  } catch {
    // Jamais bloquant.
  }
}

export type EntreeJournal = LigneJournal;

export async function listerJournal(): Promise<EntreeJournal[]> {
  const lignes = await lireLignes();
  const entrees: EntreeJournal[] = [];
  for (const ligne of lignes) {
    try {
      entrees.push(JSON.parse(ligne) as EntreeJournal);
    } catch {
      // Ligne corrompue - ignoree, jamais bloquante pour les autres.
    }
  }
  return entrees;
}

export class PartageIndisponibleError extends Error {
  constructor() {
    super("PARTAGE_INDISPONIBLE");
  }
}

/** Ouvre le partage natif Android (email, WhatsApp, etc.) sur le fichier
 * du journal tel quel - l'utilisateur choisit lui-même le moyen d'envoi au
 * support, rien n'est transmis automatiquement par l'application. */
export async function exporterJournal(): Promise<void> {
  const fichier = fichierJournal();
  if (!fichier.exists) fichier.write("");
  const disponible = await Sharing.isAvailableAsync();
  if (!disponible) throw new PartageIndisponibleError();
  await Sharing.shareAsync(fichier.uri, { mimeType: "application/x-ndjson", dialogTitle: "Exporter le journal Aurore Mobile" });
}

export async function viderJournal(): Promise<void> {
  const fichier = fichierJournal();
  if (fichier.exists) fichier.delete();
}
