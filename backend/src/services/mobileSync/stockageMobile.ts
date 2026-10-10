import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { userDataDir } from "../../database/portablePaths";
import { loadOrCreateEncryptionKey } from "../../security/encryptionAtRest";

/**
 * Stockage physique des elements captures depuis Aurore Mobile (audio/scan),
 * chiffres au repos - duplique DELIBEREMENT le meme algorithme/format que
 * services/stockageDocuments.ts (Lot 15) plutot que de le reutiliser tel
 * quel : ce module a sa propre racine de dossier (mobile-items/, pas
 * documents/<dossierId>/) et sa propre convention de nommage (par appareil,
 * pas par dossier - un MobileItem n'a pas toujours de dossierId). Meme
 * convention de duplication volontaire que stockageDocuments.ts lui-meme
 * vis-a-vis de encryptionAtRest.ts (voir son commentaire d'en-tete).
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function dossierMobileRacine(): string {
  return path.join(userDataDir(), "mobile-items");
}

function dossierAppareil(deviceId: string): string {
  return path.join(dossierMobileRacine(), deviceId);
}

export function cheminFichierMobile(deviceId: string, nomFichier: string): string {
  return path.join(dossierAppareil(deviceId), nomFichier);
}

function chiffrerBuffer(clair: Buffer): Buffer {
  const key = loadOrCreateEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const chiffre = Buffer.concat([cipher.update(clair), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, chiffre]);
}

function dechiffrerBuffer(stocke: Buffer): Buffer {
  const key = loadOrCreateEncryptionKey();
  const iv = stocke.subarray(0, IV_BYTES);
  const authTag = stocke.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const chiffre = stocke.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(chiffre), decipher.final()]);
}

/**
 * Chemin du fichier TEMPORAIRE de reception par morceaux (avant commit) -
 * dans un sous-dossier .en-cours/ par item, jamais directement sous le nom
 * final (evite qu'un commit lise un fichier partiellement ecrit en cas de
 * crash au milieu d'un PUT chunk). Chaque morceau est chiffre
 * INDIVIDUELLEMENT a l'ecriture (append) plutot qu'en une seule fois a la
 * fin : un fichier audio de 15 Mo+ ne doit jamais devoir etre entierement
 * en memoire cote serveur.
 */
function cheminChunksEnCours(deviceId: string, itemClientId: string): string {
  return path.join(dossierAppareil(deviceId), ".en-cours", `${itemClientId}.chunks`);
}

/** Ecrit (ou ajoute) un morceau chiffre individuellement - voir note
 * ci-dessus. Chaque morceau garde son propre IV/authTag (prefixe 28 octets),
 * la lecture du flux complet lors du commit les traite un par un. */
export async function ecrireChunk(deviceId: string, itemClientId: string, numero: number, contenu: Buffer): Promise<void> {
  const dir = path.dirname(cheminChunksEnCours(deviceId, itemClientId));
  await fsPromises.mkdir(dir, { recursive: true });
  const cheminNumerote = `${cheminChunksEnCours(deviceId, itemClientId)}.${numero}`;
  await fsPromises.writeFile(cheminNumerote, chiffrerBuffer(contenu), { mode: 0o600 });
}

/**
 * Assemble tous les morceaux deja recus (dans l'ordre numerique), les
 * dechiffre puis les rechiffre en un seul fichier final - verifie le
 * sha256 attendu AVANT d'ecrire le fichier final (jamais un fichier corrompu
 * marque comme recu). Retourne le nom de fichier final (UUID, jamais le nom
 * d'origine - meme contrainte que stockageDocuments.ts) et sa taille.
 * Nettoie les morceaux temporaires dans tous les cas (succes ou echec de
 * verification), pour ne jamais laisser de fichiers orphelins.
 */
export async function assemblerEtVerifier(
  deviceId: string,
  itemClientId: string,
  nombreChunksAttendu: number,
  sha256Attendu: string
): Promise<{ nomFichier: string; tailleOctets: number }> {
  const prefixe = cheminChunksEnCours(deviceId, itemClientId);
  const morceaux: Buffer[] = [];
  try {
    for (let i = 0; i < nombreChunksAttendu; i++) {
      const chemin = `${prefixe}.${i}`;
      if (!fs.existsSync(chemin)) {
        throw new Error("CHUNK_MANQUANT");
      }
      morceaux.push(dechiffrerBuffer(await fsPromises.readFile(chemin)));
    }
    const complet = Buffer.concat(morceaux);
    const sha256Reel = crypto.createHash("sha256").update(complet).digest("hex");
    if (sha256Reel !== sha256Attendu) {
      throw new Error("SHA256_INVALIDE");
    }

    const dir = dossierAppareil(deviceId);
    await fsPromises.mkdir(dir, { recursive: true });
    const nomFichier = `${crypto.randomUUID()}.enc`;
    await fsPromises.writeFile(path.join(dir, nomFichier), chiffrerBuffer(complet), { mode: 0o600 });
    return { nomFichier, tailleOctets: complet.length };
  } finally {
    // Nettoyage des morceaux temporaires, succes ou echec - jamais de
    // fichiers .chunks.N orphelins qui s'accumuleraient silencieusement.
    for (let i = 0; i < nombreChunksAttendu; i++) {
      await fsPromises.rm(`${prefixe}.${i}`, { force: true }).catch(() => undefined);
    }
  }
}

/** Lit puis dechiffre un fichier final (ecoute/telechargement depuis la
 * Boite de reception mobile, Prompt 2 - pas encore utilise dans ce lot). */
export async function lireFichierMobile(deviceId: string, nomFichier: string): Promise<Buffer> {
  const stocke = await fsPromises.readFile(cheminFichierMobile(deviceId, nomFichier));
  return dechiffrerBuffer(stocke);
}

export async function supprimerFichierMobile(deviceId: string, nomFichier: string): Promise<void> {
  await fsPromises.rm(cheminFichierMobile(deviceId, nomFichier), { force: true });
}
