import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { PermissionsAndroid, Platform } from "react-native";
import AudioRecorder from "../../modules/audio-recorder/src/AudioRecorderModule";
import { chiffrer, dechiffrer } from "../vault/vault";
import {
  enregistrerElementLocal,
  type ElementLocal,
  type MarqueurLocal,
  type StatutElementLocal,
} from "../storage/db";

/**
 * Orchestration de l'enregistrement (Prompt 4, objectif A) - le module
 * natif (modules/audio-recorder) ne fait que produire des segments AAC_ADTS
 * sur disque ; tout le chiffrement, le suivi de durée et les repères sont
 * géré ici, côté JS.
 *
 * Chaque segment est chiffré dès qu'il est signalé par le natif (polling,
 * voir démarrerPompeSegments) puis le fichier en clair est supprimé
 * immédiatement - c'est ce qui réalise l'"écriture continue et chiffrée"
 * exigée par le prompt, sans attendre la fin de tout l'enregistrement.
 */

const DUREE_SEGMENT_MS = 20000;
const INTERVALLE_POMPE_MS = 2000;

const DOSSIER_RACINE = "audio-enc";

interface SegmentChiffre {
  numero: number;
  dureeMs: number;
}

interface SessionEnCours {
  clientId: string;
  dossierTravail: string; // chemin natif des segments en clair (plein, pas file://)
  dossierChiffre: Directory;
  segments: SegmentChiffre[];
  marqueurs: MarqueurLocal[];
  dureeAccumuleeMs: number;
  debutSegmentCourantMs: number | null;
  intervallePompe: ReturnType<typeof setInterval> | null;
}

let session: SessionEnCours | null = null;

export class PermissionMicrophoneRefuseeError extends Error {
  constructor() {
    super("PERMISSION_MICROPHONE_REFUSEE");
  }
}

async function demanderPermissions(): Promise<boolean> {
  const demandes = [PermissionsAndroid.PERMISSIONS.RECORD_AUDIO];
  if (Number(Platform.Version) >= 33) {
    demandes.push("android.permission.POST_NOTIFICATIONS" as never);
  }
  const resultats = await PermissionsAndroid.requestMultiple(demandes);
  return Object.values(resultats).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

function versCheminNatif(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

function cheminSegmentChiffre(dossierChiffre: Directory, numero: number): File {
  return new File(dossierChiffre, `segment-${numero}.enc`);
}

async function traiterSegmentsEnAttente(): Promise<void> {
  if (!session) return;
  const termines = AudioRecorder.recupererSegmentsTermines();
  for (const seg of termines) {
    try {
      const fichierClair = new File(`file://${seg.chemin}`);
      if (!fichierClair.exists || (fichierClair.size ?? 0) === 0) continue;
      const octets = await fichierClair.bytes();
      const chiffre = await chiffrer(octets);
      cheminSegmentChiffre(session.dossierChiffre, seg.numero).write(chiffre);
      fichierClair.delete();
      session.segments.push({ numero: seg.numero, dureeMs: seg.dureeMs });
      session.dureeAccumuleeMs += seg.dureeMs;
    } catch {
      // Un segment illisible/corrompu est simplement perdu (quelques
      // dizaines de secondes au pire) - jamais bloquant pour la suite.
    }
  }
}

export async function demarrerEnregistrement(): Promise<{ clientId: string }> {
  if (session) throw new Error("ENREGISTREMENT_DEJA_EN_COURS");

  const permissionsAccordees = await demanderPermissions();
  if (!permissionsAccordees) throw new PermissionMicrophoneRefuseeError();

  const clientId = Crypto.randomUUID();
  const dossierChiffre = new Directory(Paths.document, DOSSIER_RACINE, clientId);
  dossierChiffre.create();
  const dossierTravail = versCheminNatif(new Directory(Paths.cache, "audio-tmp", clientId).uri);

  session = {
    clientId,
    dossierTravail,
    dossierChiffre,
    segments: [],
    marqueurs: [],
    dureeAccumuleeMs: 0,
    debutSegmentCourantMs: Date.now(),
    intervallePompe: null,
  };

  AudioRecorder.demarrer(dossierTravail, DUREE_SEGMENT_MS);
  session.intervallePompe = setInterval(() => {
    traiterSegmentsEnAttente();
  }, INTERVALLE_POMPE_MS);

  return { clientId };
}

export function estEnregistrementEnCours(): boolean {
  return session !== null;
}

export async function mettreEnPause(): Promise<void> {
  if (!session) return;
  AudioRecorder.mettreEnPause();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await traiterSegmentsEnAttente();
  session.debutSegmentCourantMs = null;
}

export function reprendre(): void {
  if (!session) return;
  AudioRecorder.reprendre();
  session.debutSegmentCourantMs = Date.now();
}

/** Durée totale actuelle, segments terminés + segment en cours - utilisée
 * pour l'affichage du chrono et pour positionner les repères. */
export function dureeEcouleeMs(): number {
  if (!session) return 0;
  const enCours = session.debutSegmentCourantMs !== null ? Date.now() - session.debutSegmentCourantMs : 0;
  return session.dureeAccumuleeMs + enCours;
}

export function niveauSonore(): number {
  return AudioRecorder.niveauSonore();
}

export function ajouterMarqueur(type: MarqueurLocal["type"], dateAudience: string | null = null): void {
  if (!session) return;
  session.marqueurs.push({ type, positionMs: dureeEcouleeMs(), dateAudience });
}

export function marqueursActuels(): MarqueurLocal[] {
  return session ? [...session.marqueurs] : [];
}

/** Attache une date au dernier repère "Prochaine audience" posé - appelé
 * après coup si l'utilisateur choisit une date dans le sélecteur (jamais
 * obligatoire, voir objectif B du prompt). */
export function definirDateProchaineAudience(dateIso: string): void {
  if (!session) return;
  for (let i = session.marqueurs.length - 1; i >= 0; i--) {
    if (session.marqueurs[i].type === "prochaine_audience") {
      session.marqueurs[i].dateAudience = dateIso;
      return;
    }
  }
}

/** Arrête l'enregistrement et enregistre l'élément local (statut
 * "en_attente"). L'envoi vers Aurore est déclenché séparément (voir
 * sync/elements.ts), jamais depuis cette fonction. */
export async function arreterEtEnregistrer(options: {
  dossierId: string | null;
  noteTexte: string | null;
}): Promise<ElementLocal> {
  if (!session) throw new Error("AUCUN_ENREGISTREMENT_EN_COURS");
  const s = session;

  if (s.intervallePompe) clearInterval(s.intervallePompe);
  AudioRecorder.arreter();
  await new Promise((resolve) => setTimeout(resolve, 500));
  await traiterSegmentsEnAttente();

  const element: ElementLocal = {
    clientId: s.clientId,
    type: "audio",
    statut: "en_attente" as StatutElementLocal,
    dossierId: options.dossierId,
    dureeSecondes: Math.round(s.dureeAccumuleeMs / 1000),
    creeLe: new Date().toISOString(),
    nombreSegments: s.segments.length,
    marqueurs: s.marqueurs,
    noteTexte: options.noteTexte,
  };
  await enregistrerElementLocal(element);

  session = null;
  return element;
}

/** Reconstitue le contenu audio en clair d'un élément déjà enregistré -
 * pour la réécoute locale ou l'envoi. Déchiffre tout en mémoire (même
 * principe que le serveur pour la lecture audio, acceptable pour des
 * fichiers de quelques dizaines de Mo). */
export async function reconstituerAudioClair(clientId: string, nombreSegments: number): Promise<Uint8Array> {
  const dossierChiffre = new Directory(Paths.document, DOSSIER_RACINE, clientId);
  const morceaux: Uint8Array[] = [];
  let tailleTotale = 0;
  for (let numero = 0; numero < nombreSegments; numero++) {
    const fichier = cheminSegmentChiffre(dossierChiffre, numero);
    if (!fichier.exists) continue;
    const contenu = await dechiffrer(await fichier.text());
    morceaux.push(contenu);
    tailleTotale += contenu.length;
  }
  const resultat = new Uint8Array(tailleTotale);
  let position = 0;
  for (const morceau of morceaux) {
    resultat.set(morceau, position);
    position += morceau.length;
  }
  return resultat;
}

/** Repart d'une session vide - utilisée par les tests (chaque test doit
 * pouvoir démarrer son propre enregistrement sans effet de bord du test
 * précédent) ET en production si une session précédente n'a pas été
 * proprement terminée (écran quitté de force, crash) pour ne jamais
 * bloquer durablement sur "ENREGISTREMENT_DEJA_EN_COURS". */
export function reinitialiserSession(): void {
  if (session?.intervallePompe) clearInterval(session.intervallePompe);
  session = null;
}

export function supprimerSegmentsLocaux(clientId: string): void {
  const dossierChiffre = new Directory(Paths.document, DOSSIER_RACINE, clientId);
  if (dossierChiffre.exists) dossierChiffre.delete();
}
