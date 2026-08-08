import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { userDataDir } from "../database/portablePaths";
import { loadOrCreateEncryptionKey } from "../security/encryptionAtRest";

/**
 * Lot 15 - stockage physique des pieces jointes de dossier (GED), chiffrees
 * au repos. Reutilise la MEME cle applicative et le MEME algorithme
 * (AES-256-GCM) que security/encryptionAtRest.ts (Lot 2bis) via
 * loadOrCreateEncryptionKey() - importee telle quelle, jamais une nouvelle
 * cle ni un nouveau mecanisme. `encryptField`/`decryptField` de ce module
 * ne conviennent PAS ici : ils operent sur des chaines UTF-8 (un fichier
 * binaire - PDF, image, .docx - n'est pas un texte UTF-8 valide, le
 * convertir le corromprait). Les fonctions ci-dessous sont donc une
 * variante binaire du meme chiffrement, en local a ce module (voir
 * README-LOT15.md pour la justification detaillee).
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * Dossier de stockage des pieces, hors du dossier d'installation de l'app
 * (jamais ecrase a la mise a jour) - meme emplacement racine que le data
 * directory Postgres portable (Lot 2) et la cle de chiffrement (Lot 2bis).
 * En mode reseau (Lot 6), ce chemin est resolu sur la machine qui execute
 * CE process Express (le serveur) : les postes clients ne lisent jamais ce
 * dossier directement, uniquement via les routes HTTP de
 * routes/documentsDossier.ts - aucune logique de stockage distribue requise.
 */
function dossierDocumentsRacine(): string {
  return path.join(userDataDir(), "documents");
}

function dossierDocumentsDossier(dossierId: string): string {
  return path.join(dossierDocumentsRacine(), dossierId);
}

function cheminFichier(dossierId: string, nomFichier: string): string {
  return path.join(dossierDocumentsDossier(dossierId), nomFichier);
}

function chiffrerBuffer(clair: Buffer): Buffer {
  const key = loadOrCreateEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const chiffre = Buffer.concat([cipher.update(clair), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format sur disque : IV (12 octets) || AuthTag (16 octets) || ciphertext -
  // binaire brut, jamais de base64 (inutile pour un fichier sur disque,
  // contrairement a un champ texte en base - economise ~33% d'espace).
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

export interface FichierEnregistre {
  nomFichier: string;
  tailleOctets: number;
}

/**
 * Chiffre puis ecrit un fichier sur disque, dans le sous-dossier du
 * dossier concerne. Nom de fichier non previsible (UUID) - le nom
 * d'origine reste uniquement en metadonnee (DocumentDossier.nomOriginal),
 * jamais utilise pour nommer le fichier physique (contrainte du prompt :
 * evite collisions et fuite d'information via le nom de fichier).
 */
export async function enregistrerFichier(dossierId: string, contenu: Buffer): Promise<FichierEnregistre> {
  const dir = dossierDocumentsDossier(dossierId);
  await fsPromises.mkdir(dir, { recursive: true });
  const nomFichier = `${crypto.randomUUID()}.enc`;
  await fsPromises.writeFile(path.join(dir, nomFichier), chiffrerBuffer(contenu), { mode: 0o600 });
  return { nomFichier, tailleOctets: contenu.length };
}

/** Lit puis dechiffre un fichier - renvoie le contenu original tel
 * qu'uploade (telechargement/apercu, voir routes/documentsDossier.ts). */
export async function lireFichier(dossierId: string, nomFichier: string): Promise<Buffer> {
  const stocke = await fsPromises.readFile(cheminFichier(dossierId, nomFichier));
  return dechiffrerBuffer(stocke);
}

/**
 * Supprime le fichier physique - idempotent (ne leve jamais si le fichier
 * est deja absent, meme raisonnement que les suppressions "tolerantes"
 * deja utilisees ailleurs dans le projet, ex. roleAudiences.ts) : le but
 * est de ne jamais laisser un fichier orphelin, pas de faire echouer la
 * suppression de l'entree en base si le fichier a deja disparu pour une
 * raison quelconque.
 */
export async function supprimerFichier(dossierId: string, nomFichier: string): Promise<void> {
  await fsPromises.rm(cheminFichier(dossierId, nomFichier), { force: true });
}

/** Reserve aux tests - verifie l'existence brute (sans dechiffrer) pour
 * confirmer qu'un fichier n'est jamais ecrit en clair sur disque. */
export function _lireFichierBrutPourTests(dossierId: string, nomFichier: string): Buffer {
  return fs.readFileSync(cheminFichier(dossierId, nomFichier));
}
