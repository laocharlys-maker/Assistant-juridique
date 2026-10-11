import * as Crypto from "expo-crypto";
import { envoyerRequeteAuthentifiee } from "../pairing/appareil";
import { reconstituerAudioClair } from "../audio/recorder";
import { reconstituerPdfClair } from "../scan/scanner";
import { listerElementsLocaux, majStatutElementLocal, majErreurEnvoiElementLocal, type ElementLocal } from "../storage/db";

/**
 * Envoi des éléments locaux vers Aurore (Prompt 4 objectifs A/D, Prompt 5
 * objectifs A-C) - réutilise le protocole déjà en place côté serveur
 * (création de l'item, puis morceaux, puis commit - voir
 * backend/src/routes/mobileSync.ts, Prompt 1/2) pour les TROIS types
 * (audio/scan/note) : rien de nouveau à inventer côté transport, seul le
 * contenu binaire envoyé change selon le type (voir contenuElement
 * ci-dessous).
 */

const TAILLE_MORCEAU_OCTETS = 256 * 1024;

function octetsVersHex(tampon: ArrayBuffer): string {
  return Array.from(new Uint8Array(tampon))
    .map((o) => o.toString(16).padStart(2, "0"))
    .join("");
}

function base64Encode(bytes: Uint8Array): string {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let resultat = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const o1 = bytes[i];
    const o2 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const o3 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    resultat += ALPHABET[o1 >> 2];
    resultat += ALPHABET[((o1 & 0x03) << 4) | (o2 === undefined ? 0 : o2 >> 4)];
    resultat += o2 === undefined ? "=" : ALPHABET[((o2 & 0x0f) << 2) | (o3 === undefined ? 0 : o3 >> 6)];
    resultat += o3 === undefined ? "=" : ALPHABET[o3 & 0x3f];
  }
  return resultat;
}

// Protege contre deux envois concurrents du meme element : l'ecran
// ApresEnregistrement declenche l'envoi en arriere-plan SANS l'attendre
// (pour ne jamais retarder la navigation), et l'ecran MesElements relance
// aussi l'envoi des elements "en_attente" a l'ouverture - sans ce verrou,
// les deux sequences de requetes authentifiees s'entrelacent et le
// compteur anti-rejeu (voir middleware/mobileDeviceAuth.ts) rejette l'une
// des deux, laissant l'item bloque au statut serveur "recu".
const envoisEnCours = new Set<string>();

/** Envoie un élément local déjà enregistré - idempotent côté serveur
 * (clientId), peut être rappelé sans risque après une coupure réseau,
 * jamais en parallèle pour le même élément (voir envoisEnCours). */
export async function envoyerElement(element: ElementLocal): Promise<void> {
  if (envoisEnCours.has(element.clientId)) return;
  envoisEnCours.add(element.clientId);
  try {
    await envoyerElementSansVerrou(element);
  } finally {
    envoisEnCours.delete(element.clientId);
  }
}

export class EnregistrementVideError extends Error {
  constructor() {
    super("ENREGISTREMENT_VIDE");
  }
}

/** Contenu binaire a envoyer, selon le type - audio et scan relisent leur
 * fichier chiffre local, une note n'a pas de fichier propre : son contenu
 * EST le texte lui-meme (encode en UTF-8), pour passer par le meme cycle
 * morceaux/commit que les deux autres types (voir routes/mobileSync.ts,
 * creerItemSchema qui exige nombreChunksAttendu/sha256Attendu quel que soit
 * le type) sans avoir a modifier le serveur. */
async function contenuElement(element: ElementLocal): Promise<Uint8Array> {
  switch (element.type) {
    case "audio":
      return reconstituerAudioClair(element.clientId, element.nombreSegments ?? 0);
    case "scan":
      return reconstituerPdfClair(element.clientId);
    case "note":
      return new TextEncoder().encode(element.noteTexte ?? "");
  }
}

async function envoyerElementSansVerrou(element: ElementLocal): Promise<void> {
  const contenu = await contenuElement(element);
  if (contenu.length === 0) {
    // Audio : enregistrement trop court pour que le premier segment ait
    // ete valide par Android (MediaRecorder.stop() echoue silencieusement
    // sur un segment de quelques centaines de ms). Scan/note : ne devrait
    // jamais arriver (terminerScan/creerNoteLocale refusent deja un
    // contenu vide a la creation) - traite pareil par securite plutot que
    // de contacter le serveur pour echouer a coup sur.
    throw new EnregistrementVideError();
  }
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, contenu.slice());
  const sha256 = octetsVersHex(digest);
  const nombreChunks = Math.max(1, Math.ceil(contenu.length / TAILLE_MORCEAU_OCTETS));

  const marqueurs = element.marqueurs ?? [];
  const { itemId } = await envoyerRequeteAuthentifiee<{ itemId: string }>("/api/m/items", {
    clientId: element.clientId,
    type: element.type,
    dossierId: element.dossierId,
    typeScan: element.typeScan ?? null,
    dureeSecondes: element.dureeSecondes,
    creeLeSurAppareil: element.creeLe,
    prochaineAudience: marqueurs.find((m) => m.type === "prochaine_audience")?.dateAudience ?? null,
    noteTexte: element.noteTexte,
    nombreChunksAttendu: nombreChunks,
    sha256Attendu: sha256,
  });

  for (let numero = 0; numero < nombreChunks; numero++) {
    const debut = numero * TAILLE_MORCEAU_OCTETS;
    const morceau = contenu.subarray(debut, Math.min(debut + TAILLE_MORCEAU_OCTETS, contenu.length));
    await envoyerRequeteAuthentifiee(`/api/m/items/${itemId}/chunks/${numero}`, {
      contenuBase64: base64Encode(morceau),
    });
  }

  await envoyerRequeteAuthentifiee(`/api/m/items/${itemId}/commit`, { nombreChunks, sha256 });

  // L'element est considere envoye des le commit reussi (le fichier est
  // bien recu et verifie cote serveur) - un echec sur l'envoi des reperes
  // ci-dessous ne doit jamais faire regresser "Mes elements" a "en
  // attente" pour un enregistrement deja bel et bien arrive a Aurore.
  await majStatutElementLocal(element.clientId, "envoye");
  await majErreurEnvoiElementLocal(element.clientId, null);

  if (marqueurs.length > 0) {
    await envoyerRequeteAuthentifiee(`/api/m/items/${itemId}/marqueurs`, {
      marqueurs: marqueurs.map((m) => ({
        type: m.type,
        positionMs: m.positionMs,
        dateAudience: m.dateAudience,
      })),
    });
  }
}

/** Envoie tous les éléments encore "en_attente" - appelée à l'ouverture de
 * l'écran "Mes éléments" et périodiquement depuis l'accueil, jamais en
 * tâche de fond pure (pas de garantie Android équivalente au spike). */
export async function envoyerElementsEnAttente(): Promise<void> {
  const elements = await listerElementsLocaux();
  for (const element of elements) {
    if (element.statut !== "en_attente") continue;
    try {
      await envoyerElement(element);
    } catch (erreur) {
      // Coupure réseau ou Aurore éteint - on réessaiera au prochain appel,
      // jamais bloquant pour les autres éléments de la liste. L'erreur
      // reste néanmoins visible dans "Mes éléments" (avant ce correctif,
      // un échec ici était totalement silencieux pour l'utilisateur).
      const message =
        erreur instanceof EnregistrementVideError
          ? "Enregistrement trop court, aucun audio valide - supprimable (bouton ci-dessous)."
          : erreur instanceof Error
            ? erreur.message
            : "Erreur inconnue";
      await majErreurEnvoiElementLocal(element.clientId, message).catch(() => undefined);
    }
  }
}

/** Met à jour le statut local ("envoye" -> "confirme") des éléments déjà
 * envoyés, en interrogeant Aurore. */
export async function verifierConfirmations(): Promise<void> {
  const elements = await listerElementsLocaux();
  const enAttenteConfirmation = elements.filter((e) => e.statut === "envoye");
  if (enAttenteConfirmation.length === 0) return;

  try {
    const { statuts } = await envoyerRequeteAuthentifiee<{ statuts: Record<string, "envoye" | "confirme"> }>(
      "/api/m/items/statuts",
      { clientIds: enAttenteConfirmation.map((e) => e.clientId) }
    );
    for (const element of enAttenteConfirmation) {
      if (statuts[element.clientId] === "confirme") {
        await majStatutElementLocal(element.clientId, "confirme");
      }
    }
  } catch {
    // Aurore injoignable pour l'instant - sans conséquence, nouvel essai
    // au prochain appel.
  }
}
