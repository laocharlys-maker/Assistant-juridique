import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { PDFDocument } from "pdf-lib";
import ImageWarp, { type PointPixel } from "../../modules/image-warp/src/ImageWarpModule";
import { chiffrer, dechiffrer } from "../vault/vault";
import { verifierEspaceDisponible } from "../storage/espace";
import { enregistrerElementLocal, type ElementLocal, type StatutElementLocal, type TypeScanLocal } from "../storage/db";

/**
 * Orchestration du scan de documents (Prompt 5, objectif A) - voir
 * docs/lot10/05-scan.md pour le choix de ne dépendre d'aucune bibliothèque
 * de scan tierce (Google ML Kit envoie de la télémétrie) : la capture passe
 * par expo-camera (déjà une dépendance), le redressement de perspective par
 * le module natif maison `modules/image-warp` (API Android standard), et
 * l'assemblage PDF par pdf-lib (JS pur, aucun réseau).
 *
 * Même principe que audio/recorder.ts : tout le travail de fichiers/
 * chiffrement se fait ici, jamais côté écran.
 */

const DOSSIER_RACINE = "scans-enc";

interface SessionScan {
  clientId: string;
  dossierTravail: Directory; // cache prive, photos brutes + pages redressees en clair (temporaire)
  pages: string[]; // chemins file:// des pages redressees, dans l'ordre final
}

let session: SessionScan | null = null;

export class ScanDejaEnCoursError extends Error {
  constructor() {
    super("SCAN_DEJA_EN_COURS");
  }
}

export function demarrerScan(): { clientId: string } {
  if (session) throw new ScanDejaEnCoursError();
  verifierEspaceDisponible();
  const clientId = Crypto.randomUUID();
  const dossierTravail = new Directory(Paths.cache, "scan-tmp", clientId);
  dossierTravail.create({ idempotent: true });
  session = { clientId, dossierTravail, pages: [] };
  return { clientId };
}

export function estScanEnCours(): boolean {
  return session !== null;
}

function cheminNatif(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

/** Redresse la photo brute capturée (voir modules/image-warp) et l'ajoute
 * comme dernière page de la session en cours. `coins` doit déjà être
 * exprimé en coordonnées PIXEL de la photo (conversion depuis les
 * coordonnées écran faite côté écran, voir ScanScreen). */
export async function ajouterPage(cheminPhotoBrute: string, coins: PointPixel[]): Promise<number> {
  if (!session) throw new Error("AUCUN_SCAN_EN_COURS");
  const s = session;
  const numero = s.pages.length;
  const destination = new File(s.dossierTravail, `page-${numero}.jpg`);
  await ImageWarp.redresser(cheminNatif(cheminPhotoBrute), coins, cheminNatif(destination.uri));
  new File(cheminPhotoBrute).delete();
  s.pages.push(destination.uri);
  return s.pages.length;
}

export function listerPages(): string[] {
  return session ? [...session.pages] : [];
}

export function supprimerPage(index: number): void {
  if (!session) return;
  const [chemin] = session.pages.splice(index, 1);
  if (chemin) new File(chemin).delete();
}

export function deplacerPage(depuis: number, vers: number): void {
  if (!session) return;
  const [chemin] = session.pages.splice(depuis, 1);
  if (chemin === undefined) return;
  session.pages.splice(vers, 0, chemin);
}

export class AucunePageError extends Error {
  constructor() {
    super("AUCUNE_PAGE");
  }
}

/** Assemble les pages en un seul PDF, le chiffre et enregistre l'élément
 * local (statut "en_attente", même cycle que l'audio) - voir
 * sync/elements.ts pour l'envoi. */
export async function terminerScan(options: {
  dossierId: string | null;
  typeScan: TypeScanLocal;
  noteTexte: string | null;
}): Promise<ElementLocal> {
  if (!session) throw new Error("AUCUN_SCAN_EN_COURS");
  const s = session;
  if (s.pages.length === 0) throw new AucunePageError();

  const pdf = await PDFDocument.create();
  for (const chemin of s.pages) {
    const octets = await new File(chemin).bytes();
    const image = await pdf.embedJpg(octets);
    const page = pdf.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  const pdfBytes = await pdf.save();

  const chiffre = await chiffrer(pdfBytes);
  const dossierChiffreRacine = new Directory(Paths.document, DOSSIER_RACINE);
  dossierChiffreRacine.create({ idempotent: true });
  const fichierChiffre = new File(dossierChiffreRacine, `${s.clientId}.enc`);
  fichierChiffre.write(chiffre);

  // Nettoyage des photos/pages en clair temporaires - jamais conservees une
  // fois le PDF chiffre ecrit (meme principe que l'audio : rien en clair ne
  // doit survivre sur le disque plus longtemps que necessaire).
  if (s.dossierTravail.exists) s.dossierTravail.delete();

  const element: ElementLocal = {
    clientId: s.clientId,
    type: "scan",
    statut: "en_attente" as StatutElementLocal,
    dossierId: options.dossierId,
    typeScan: options.typeScan,
    nombrePages: s.pages.length,
    creeLe: new Date().toISOString(),
    noteTexte: options.noteTexte,
    derniereErreurEnvoi: null,
  };
  await enregistrerElementLocal(element);

  session = null;
  return element;
}

/** Abandonne la session en cours (retour arrière depuis l'écran de scan) -
 * supprime les photos/pages en clair non encore assemblées. */
export function annulerScan(): void {
  if (!session) return;
  if (session.dossierTravail.exists) session.dossierTravail.delete();
  session = null;
}

/** Déchiffre le PDF d'un scan déjà enregistré - pour l'envoi (sync/elements.ts)
 * et un éventuel aperçu local. */
export async function reconstituerPdfClair(clientId: string): Promise<Uint8Array> {
  const fichier = new File(Paths.document, DOSSIER_RACINE, `${clientId}.enc`);
  if (!fichier.exists) return new Uint8Array(0);
  return dechiffrer(await fichier.text());
}

/** Supprime le PDF chiffré d'un scan - appelé uniquement une fois l'élément
 * confirmé par Aurore (voir MesElementsScreen, même contrainte que l'audio). */
export function supprimerScanLocal(clientId: string): void {
  const fichier = new File(Paths.document, DOSSIER_RACINE, `${clientId}.enc`);
  if (fichier.exists) fichier.delete();
}

/** Repart d'une session vide - utilisée par les tests, même rôle que
 * reinitialiserSession() côté audio. */
export function reinitialiserSessionScan(): void {
  session = null;
}
