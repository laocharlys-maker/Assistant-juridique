import crypto from "node:crypto";

/**
 * Primitives cryptographiques du protocole d'appairage/synchronisation
 * mobile (Lot 10) - voir docs/lot10/01-protocole.md pour le protocole
 * complet et la justification du choix (X25519 natif Node plutot que
 * tweetnacl, ecart volontaire par rapport au plan initial).
 *
 * Aucune dependance tierce : tout repose sur le module `crypto` natif
 * (X25519 via generateKeyPairSync/diffieHellman, HKDF via hkdfSync,
 * AES-256-GCM deja utilise partout ailleurs dans ce projet - voir
 * security/encryptionAtRest.ts et services/stockageDocuments.ts).
 */

const AES_ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SK_BYTES = 32;
const HKDF_SALT = Buffer.from("aurore-mobile-v1", "utf8");

export interface PaireClesX25519 {
  /** Cle publique brute (32 octets), encodee en base64. */
  clePubliqueBase64: string;
  /** Objet KeyObject prive Node - jamais serialise tel quel ailleurs que via exporterClePriveeBase64(). */
  clePriveeKeyObject: crypto.KeyObject;
}

/** Genere une nouvelle paire de cles X25519 (ECDH) - utilisee une seule
 * fois par cabinet, a la premiere activation de la synchronisation mobile
 * (voir protocole section 2). */
export function genererPaireClesX25519(): PaireClesX25519 {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    clePubliqueBase64: exporterClePubliqueBase64(publicKey),
    clePriveeKeyObject: privateKey,
  };
}

/** Exporte une cle publique X25519 (KeyObject) en 32 octets bruts base64 -
 * format compact transmis dans le QR, jamais le DER/SPKI complet. */
export function exporterClePubliqueBase64(clePublique: crypto.KeyObject): string {
  const der = clePublique.export({ type: "spki", format: "der" });
  // Le DER SPKI d'une cle X25519 fait 44 octets : 12 octets d'en-tete ASN.1
  // fixe (toujours identique pour cet algorithme) + 32 octets de cle brute.
  // On ne transmet que les 32 octets bruts, reconstruits a l'import
  // (importerClePubliqueBase64 ci-dessous) - evite de faire circuler/stocker
  // la structure ASN.1 complete pour rien.
  return der.subarray(der.length - 32).toString("base64");
}

/** Reconstruit un objet KeyObject public X25519 depuis les 32 octets bruts
 * (reciproque de exporterClePubliqueBase64). */
export function importerClePubliqueBase64(base64: string): crypto.KeyObject {
  const brute = Buffer.from(base64, "base64");
  if (brute.length !== 32) {
    throw new Error("CLE_PUBLIQUE_INVALIDE");
  }
  // En-tete ASN.1 SPKI fixe pour X25519 (RFC 8410) - identique a chaque
  // fois, seuls les 32 derniers octets (la cle elle-meme) varient.
  const enTeteSpkiX25519 = Buffer.from("302a300506032b656e032100", "hex");
  const der = Buffer.concat([enTeteSpkiX25519, brute]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Exporte la cle privee en base64 PKCS8 complet (DER) - UNIQUEMENT pour la
 * stocker chiffree au repos (Cabinet.mobileServerClePrivee, via
 * encryptField() - voir security/prismaEncryption.ts), jamais transmise. */
export function exporterClePriveeBase64(clePrivee: crypto.KeyObject): string {
  return clePrivee.export({ type: "pkcs8", format: "der" }).toString("base64");
}

export function importerClePriveeBase64(base64: string): crypto.KeyObject {
  return crypto.createPrivateKey({ key: Buffer.from(base64, "base64"), format: "der", type: "pkcs8" });
}

/**
 * Calcule la cle partagee SK (32 octets) a partir d'un ECDH X25519 suivi
 * d'une derivation HKDF-SHA256 - voir protocole section 4. Deterministe :
 * les deux parties (PC et telephone) obtiennent EXACTEMENT la meme valeur
 * sans jamais l'avoir transmise.
 */
export function calculerCleParGesee(
  clePrivee: crypto.KeyObject,
  clePubliqueAutre: crypto.KeyObject,
  deviceId: string
): Buffer {
  const secretEcdh = crypto.diffieHellman({ privateKey: clePrivee, publicKey: clePubliqueAutre });
  return Buffer.from(
    crypto.hkdfSync("sha256", secretEcdh, HKDF_SALT, Buffer.from(deviceId, "utf8"), SK_BYTES)
  );
}

/**
 * Chiffre `plaintext` (JSON serialise par l'appelant) avec SK, en liant
 * `aad` (donnees authentifiees additionnelles - deviceId/compteur/horodatage,
 * voir protocole section 4) au tag d'authentification : falsifier l'un de
 * ces champs invalide le dechiffrement, meme si l'enveloppe binaire est par
 * ailleurs valide. Retourne l'enveloppe complete en base64 :
 * nonce(12) || ciphertext || authTag(16).
 */
export function chiffrerEnveloppe(sk: Buffer, plaintext: Buffer, aad: Buffer): string {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, sk, nonce);
  cipher.setAAD(aad);
  const chiffre = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, chiffre, authTag]).toString("base64");
}

export class EnveloppeInvalideError extends Error {
  constructor() {
    super("ENVELOPPE_INVALIDE");
  }
}

/** Dechiffre une enveloppe produite par chiffrerEnveloppe() - leve
 * EnveloppeInvalideError si le tag d'authentification ne correspond pas
 * (cle incorrecte, aad modifiee, ou enveloppe corrompue/rejouee avec un
 * aad different de celui d'origine). */
export function dechiffrerEnveloppe(sk: Buffer, enveloppeBase64: string, aad: Buffer): Buffer {
  let brut: Buffer;
  try {
    brut = Buffer.from(enveloppeBase64, "base64");
  } catch {
    throw new EnveloppeInvalideError();
  }
  if (brut.length < NONCE_BYTES + AUTH_TAG_BYTES) {
    throw new EnveloppeInvalideError();
  }
  const nonce = brut.subarray(0, NONCE_BYTES);
  const authTag = brut.subarray(brut.length - AUTH_TAG_BYTES);
  const chiffre = brut.subarray(NONCE_BYTES, brut.length - AUTH_TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv(AES_ALGORITHM, sk, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(chiffre), decipher.final()]);
  } catch {
    throw new EnveloppeInvalideError();
  }
}

/** Secret d'appairage a usage unique (32 octets) - voir protocole section 3.1. */
export function genererSecretAppairage(): { secretBase64: string; secretHash: string } {
  const secret = crypto.randomBytes(32);
  return { secretBase64: secret.toString("base64"), secretHash: hacherSecret(secret) };
}

export function hacherSecret(secret: Buffer): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** Comparaison en temps constant - jamais `===` sur un secret (protocole section 3.2). */
export function secretsEgaux(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
