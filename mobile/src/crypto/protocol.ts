import { x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import * as Crypto from "expo-crypto";

/**
 * Cote TÉLÉPHONE du protocole d'appairage/synchronisation (Lot 10) - voir
 * docs/lot10/01-protocole.md pour le protocole complet. Doit produire
 * EXACTEMENT les mêmes résultats que backend/src/services/mobileSync/crypto.ts
 * (côté PC, module `crypto` natif de Node) : X25519 (ECDH), HKDF-SHA256,
 * AES-256-GCM. Interopérabilité vérifiée explicitement (voir
 * protocol.test.ts, vecteurs fixes partagés) - @noble/curves/ciphers/hashes
 * sont des implémentations pures JS, sans dépendance native, ce qui évite
 * tout lien natif supplémentaire à maintenir pour Aurore Mobile (le projet
 * a déjà expo-secure-store/expo-sqlite/expo-camera comme modules natifs
 * nécessaires - pas un de plus pour la seule cryptographie).
 */

const HKDF_SALT = new TextEncoder().encode("aurore-mobile-v1");
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const SK_BYTES = 32;

export interface PaireClesTelephone {
  clePriveeRaw: Uint8Array;
  clePubliqueRaw: Uint8Array;
}

/** Clé permanente du téléphone - générée une seule fois, au premier
 * lancement (voir vault/vault.ts pour son stockage dans le coffre
 * matériel), jamais régénérée ensuite (ça invaliderait l'appairage). */
export function genererPaireClesTelephone(): PaireClesTelephone {
  const clePriveeRaw = x25519.utils.randomSecretKey();
  const clePubliqueRaw = x25519.getPublicKey(clePriveeRaw);
  return { clePriveeRaw, clePubliqueRaw };
}

export function clePubliqueVersBase64(clePublique: Uint8Array): string {
  return base64Encode(clePublique);
}

export function clePubliqueDepuisBase64(base64: string): Uint8Array {
  const brute = base64Decode(base64);
  if (brute.length !== 32) {
    throw new Error("CLE_PUBLIQUE_INVALIDE");
  }
  return brute;
}

export function clePriveeVersBase64(clePrivee: Uint8Array): string {
  return base64Encode(clePrivee);
}

export function clePriveeDepuisBase64(base64: string): Uint8Array {
  return base64Decode(base64);
}

/**
 * Calcule la clé partagée SK (32 octets) - ECDH X25519 puis HKDF-SHA256,
 * IDENTIQUE au calcul côté PC (voir protocole section 4). `deviceId` est
 * l'identifiant reçu du PC à la fin de l'appairage (POST /api/m/appairage/demander).
 */
export function calculerCleParGesee(clePriveeRaw: Uint8Array, clePubliquePcRaw: Uint8Array, deviceId: string): Uint8Array {
  const secretEcdh = x25519.getSharedSecret(clePriveeRaw, clePubliquePcRaw);
  return hkdf(sha256, secretEcdh, HKDF_SALT, new TextEncoder().encode(deviceId), SK_BYTES);
}

/** Chiffre `plaintext` avec SK, AAD liée au tag d'authentification - voir
 * backend/src/services/mobileSync/crypto.ts (chiffrerEnveloppe), même
 * format binaire exact : nonce(12) || ciphertext || authTag(16), en base64. */
export function chiffrerEnveloppe(sk: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): string {
  const nonce = randomBytes(NONCE_BYTES);
  const chiffre = gcm(sk, nonce, aad).encrypt(plaintext);
  const enveloppe = new Uint8Array(nonce.length + chiffre.length);
  enveloppe.set(nonce, 0);
  enveloppe.set(chiffre, nonce.length);
  return base64Encode(enveloppe);
}

export class EnveloppeInvalideError extends Error {
  constructor() {
    super("ENVELOPPE_INVALIDE");
  }
}

/** Déchiffre une enveloppe reçue du PC (même format) - lève
 * EnveloppeInvalideError si le tag d'authentification ne correspond pas. */
export function dechiffrerEnveloppe(sk: Uint8Array, enveloppeBase64: string, aad: Uint8Array): Uint8Array {
  let brut: Uint8Array;
  try {
    brut = base64Decode(enveloppeBase64);
  } catch {
    throw new EnveloppeInvalideError();
  }
  if (brut.length < NONCE_BYTES + AUTH_TAG_BYTES) {
    throw new EnveloppeInvalideError();
  }
  const nonce = brut.subarray(0, NONCE_BYTES);
  const chiffreEtTag = brut.subarray(NONCE_BYTES);
  try {
    return gcm(sk, nonce, aad).decrypt(chiffreEtTag);
  } catch {
    throw new EnveloppeInvalideError();
  }
}

/** Construit l'AAD exactement comme le serveur l'attend (protocole section 4) -
 * ordre des clés JSON significatif (JSON.stringify d'un objet littéral
 * produit toujours le même ordre pour les mêmes clés en JS/TS, mais on fixe
 * explicitement l'ordre ici pour ne jamais dépendre de ce détail d'implémentation). */
export function construireAad(deviceId: string, compteur: number, horodatage: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ deviceId, compteur, horodatage }));
}

function randomBytes(taille: number): Uint8Array {
  // expo-crypto (natif, deja une dependance du projet pour d'autres usages)
  // plutot que globalThis.crypto - disponibilite non garantie selon la
  // version d'Hermes, jamais verifiee explicitement.
  return Crypto.getRandomBytes(taille);
}

// Base64 ecrit a la main (jamais btoa/atob - disponibilite non garantie sur
// Hermes selon la version, jamais verifiee explicitement ici - ni Buffer,
// absent par defaut en React Native sans polyfill) : algorithme standard,
// aucune dependance d'environnement, fonctionne a l'identique en Jest (Node)
// et sur l'appareil reel (Hermes).
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(bytes: Uint8Array): string {
  let resultat = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const octet1 = bytes[i];
    const octet2 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const octet3 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    resultat += BASE64_ALPHABET[octet1 >> 2];
    resultat += BASE64_ALPHABET[((octet1 & 0x03) << 4) | (octet2 === undefined ? 0 : octet2 >> 4)];
    resultat += octet2 === undefined ? "=" : BASE64_ALPHABET[((octet2 & 0x0f) << 2) | (octet3 === undefined ? 0 : octet3 >> 6)];
    resultat += octet3 === undefined ? "=" : BASE64_ALPHABET[octet3 & 0x3f];
  }
  return resultat;
}

function base64Decode(base64: string): Uint8Array {
  const propre = base64.replace(/=+$/, "");
  const octets: number[] = [];
  let buffer = 0;
  let bitsAccumules = 0;
  for (const char of propre) {
    const valeur = BASE64_ALPHABET.indexOf(char);
    if (valeur === -1) continue; // ignore espaces/retours a la ligne eventuels
    buffer = (buffer << 6) | valeur;
    bitsAccumules += 6;
    if (bitsAccumules >= 8) {
      bitsAccumules -= 8;
      octets.push((buffer >> bitsAccumules) & 0xff);
    }
  }
  return new Uint8Array(octets);
}
