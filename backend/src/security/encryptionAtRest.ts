import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { secretsDir } from "../database/portablePaths";

/**
 * Chiffrement au repos des champs sensibles (Lot 2bis) - approche (b) :
 * AES-256-GCM cote Node (module `crypto` natif, aucune dependance tierce),
 * plutot que pgcrypto cote PostgreSQL. Voir README-LOT2BIS.md pour la
 * justification du choix. Ce module ne connait rien de Prisma ni des
 * modeles metier : il expose uniquement des primitives generiques
 * encrypt/decrypt, appliquees aux champs designes par
 * ../security/prismaEncryption.ts.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
/** Prefixe distinguant une valeur chiffree par ce lot d'une valeur en clair
 * ecrite avant son activation (retro-compatibilite - voir decryptField). */
const ENCRYPTED_PREFIX = "enc:v1";

export class FieldEncryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FieldEncryptionError";
  }
}

interface EncryptionKeyFile {
  version: 1;
  generatedAt: string;
  keyBase64: string;
}

function encryptionKeyFilePath(): string {
  return path.join(secretsDir(), "encryption-key.json");
}

/**
 * Meme logique de restriction de permissions que credentialsStore.ts
 * (icacls sur Windows, chmod ailleurs) - dupliquee volontairement plutot que
 * partagee : chaque module de secrets reste autonome, comme deja pratique
 * pour scripts/restore-backup.js (voir README-LOT2.md).
 */
function restrictFilePermissions(filePath: string): void {
  if (process.platform === "win32") {
    try {
      execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], {
        stdio: "pipe",
      });
    } catch (error) {
      console.warn(
        `[encryption-at-rest] impossible de restreindre les permissions de ${filePath} via icacls (ignore) :`,
        error instanceof Error ? error.message : error
      );
    }
  } else {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      console.warn(`[encryption-at-rest] impossible de restreindre les permissions de ${filePath} (ignore).`, error);
    }
  }
}

let cachedKey: Buffer | null = null;

/**
 * Charge la cle de chiffrement applicative, ou en genere une nouvelle a la
 * toute premiere utilisation (une cle unique par installation, jamais
 * partagee entre cabinets - voir README-LOT2BIS.md). Priorite :
 * 1. AURORE_ENCRYPTION_KEY (variable d'environnement, base64 32 octets) -
 *    utile pour une gestion de cle externalisee (coffre-fort secret gere par
 *    l'exploitant), jamais loguee.
 * 2. Fichier genere localement dans secretsDir() (meme dossier protege que
 *    les identifiants Postgres portable du Lot 2).
 */
export function loadOrCreateEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const envKey = process.env.AURORE_ENCRYPTION_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "base64");
    if (buf.length !== KEY_BYTES) {
      throw new FieldEncryptionError(
        `AURORE_ENCRYPTION_KEY invalide : ${KEY_BYTES} octets attendus une fois decodee en base64, ${buf.length} obtenus.`
      );
    }
    cachedKey = buf;
    return cachedKey;
  }

  const filePath = encryptionKeyFilePath();
  if (fs.existsSync(filePath)) {
    let parsed: EncryptionKeyFile;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as EncryptionKeyFile;
    } catch (error) {
      throw new FieldEncryptionError(`Fichier de cle de chiffrement illisible (${filePath}).`, { cause: error });
    }
    const buf = Buffer.from(parsed.keyBase64, "base64");
    if (buf.length !== KEY_BYTES) {
      throw new FieldEncryptionError(`Fichier de cle de chiffrement corrompu (${filePath}) : longueur invalide.`);
    }
    cachedKey = buf;
    return cachedKey;
  }

  const key = crypto.randomBytes(KEY_BYTES);
  const payload: EncryptionKeyFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keyBase64: key.toString("base64"),
  };
  fs.mkdirSync(secretsDir(), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  restrictFilePermissions(filePath);
  console.log(
    `[encryption-at-rest] cle de chiffrement generee pour cette installation (${filePath}). ` +
      "Sauvegarder ce fichier au meme titre que les identifiants Postgres - sa perte rend les donnees chiffrees irrecuperables."
  );
  cachedKey = key;
  return cachedKey;
}

export function encryptField(plainText: string | null | undefined): string | null {
  if (plainText === null || plainText === undefined) return null;
  const key = loadOrCreateEncryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [ENCRYPTED_PREFIX, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(
    ":"
  );
}

export function decryptField(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!stored.startsWith(`${ENCRYPTED_PREFIX}:`)) {
    // Valeur en clair : donnee ecrite avant l'activation de ce lot (ou
    // colonne pas encore repassee par une ecriture depuis). On la renvoie
    // telle quelle plutot que d'echouer, pour ne jamais casser une fiche
    // existante lors du deploiement initial de ce lot.
    return stored;
  }
  // "enc:v1:<iv>:<tag>:<ciphertext>" - le prefixe lui-meme contient un ":",
  // d'ou 5 segments au total (et non 4) une fois decoupe.
  const parts = stored.split(":");
  if (parts.length !== 5) {
    throw new FieldEncryptionError(
      "Champ chiffre corrompu : structure inattendue (prefixe reconnu mais decoupage invalide)."
    );
  }
  const [, , ivB64, authTagB64, ciphertextB64] = parts;
  const key = loadOrCreateEncryptionKey();
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch (error) {
    // Ne jamais loguer la cle ni le texte chiffre en clair - seulement le
    // fait qu'un dechiffrement a echoue, pour permettre le diagnostic (cle
    // absente/incorrecte apres reinstallation, donnee corrompue) sans
    // exposer de secret. Voir README-LOT2BIS.md "perte de cle".
    console.error(
      "[encryption-at-rest] echec du dechiffrement d'un champ sensible - cle de chiffrement absente/incorrecte, " +
        "ou donnee corrompue. Voir README-LOT2BIS.md (section 'perte de cle')."
    );
    throw new FieldEncryptionError(
      "Impossible de dechiffrer une donnee sensible : cle de chiffrement absente/incorrecte pour cette installation, " +
        "ou donnee corrompue.",
      { cause: error }
    );
  }
}

/** Variante JSON : serialise puis chiffre, pour les colonnes `Json?` (ex: Action.champsDocument). */
export function encryptJsonField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return encryptField(JSON.stringify(value));
}

/**
 * Ne gere pas les sentinelles Prisma.JsonNull/DbNull/AnyNull (non utilisees
 * sur champsDocument dans ce projet a ce jour - voir grep dans
 * README-LOT2BIS.md). Si du code futur les utilise, cette fonction devra
 * etre etendue en consequence.
 */
export function decryptJsonField(stored: unknown): unknown {
  if (stored === null || stored === undefined) return stored;
  if (typeof stored !== "string") {
    // Deja une valeur JSON structuree : donnee ecrite avant l'activation de
    // ce lot (Postgres la stockait telle quelle), ou lue via un chemin qui
    // ne passe pas par cette couche de chiffrement.
    return stored;
  }
  const decrypted = decryptField(stored);
  if (decrypted === null) return null;
  if (!stored.startsWith(`${ENCRYPTED_PREFIX}:`)) {
    // decryptField renvoie stored tel quel car non prefixe - ici stored est
    // suppose etre du JSON valide (chaine JSON deja en clair, cas anterieur
    // a ce lot).
    try {
      return JSON.parse(decrypted);
    } catch {
      return decrypted;
    }
  }
  return JSON.parse(decrypted);
}
