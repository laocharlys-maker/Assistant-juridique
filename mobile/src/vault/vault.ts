import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { gcm } from "@noble/ciphers/aes.js";

/**
 * Coffre chiffré d'Aurore Mobile (Prompt 3, objectif B) - une clé maîtresse
 * unique, générée au tout premier lancement, jamais exportée en clair hors
 * de ce module. `expo-secure-store` chiffre lui-même chaque valeur stockée
 * via le coffre matériel du système (Android Keystore quand disponible) -
 * c'est CE coffre matériel qui rend la clé maîtresse "non exportable" au
 * sens du plan (la clé AES applicative elle-même doit être lisible en JS
 * pour chiffrer/déchiffrer, comme côté serveur avec
 * security/encryptionAtRest.ts - c'est la protection OS en dessous qui
 * empêche son extraction hors de l'appareil/app).
 *
 * Même algorithme et même format binaire que le serveur (AES-256-GCM,
 * nonce(12) || ciphertext || authTag(16)) - voir
 * backend/src/services/stockageDocuments.ts - pour qu'un éventuel transfert
 * de fichier chiffré entre les deux côtés (hors périmètre de ce prompt)
 * n'ait jamais besoin d'un troisième format.
 *
 * Choix explicite : chiffrement APPLICATIF des champs/valeurs stockées
 * (base SQLite incluse, voir storage/db.ts) plutôt qu'un chiffrement de la
 * base entière façon SQLCipher - évite une dépendance native supplémentaire
 * (op-sqlite ou équivalent), cohérent avec le choix déjà fait côté serveur
 * (chiffrement par champ, jamais par disque entier).
 */

const CLE_MAITRESSE_STORE_KEY = "aurore_mobile_cle_maitresse_v1";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const CLE_BYTES = 32;

let cleMaitresseCache: Uint8Array | null = null;

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

function base64Decode(base64: string): Uint8Array {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const propre = base64.replace(/=+$/, "");
  const octets: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of propre) {
    const valeur = ALPHABET.indexOf(char);
    if (valeur === -1) continue;
    buffer = (buffer << 6) | valeur;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      octets.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(octets);
}

/** Génère (une seule fois, au premier lancement) ou charge la clé maîtresse
 * depuis le coffre matériel. Jamais régénérée tant que l'app n'est pas
 * désinstallée (SecureStore est vidé à la désinstallation Android - voir
 * critère d'acceptation du prompt : "après désinstallation puis
 * réinstallation, les anciennes données sont inaccessibles"). */
export async function chargerOuCreerCleMaitresse(): Promise<Uint8Array> {
  if (cleMaitresseCache) return cleMaitresseCache;

  const stockee = await SecureStore.getItemAsync(CLE_MAITRESSE_STORE_KEY);
  if (stockee) {
    cleMaitresseCache = base64Decode(stockee);
    return cleMaitresseCache;
  }

  const nouvelleCle = Crypto.getRandomBytes(CLE_BYTES);
  await SecureStore.setItemAsync(CLE_MAITRESSE_STORE_KEY, base64Encode(nouvelleCle), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  cleMaitresseCache = nouvelleCle;
  return nouvelleCle;
}

/** Vide le cache mémoire de la clé maîtresse (jamais le coffre matériel
 * lui-même) - utilisé uniquement par les tests, pour repartir d'un état
 * propre entre deux scénarios. */
export function _reinitialiserCachePourTests(): void {
  cleMaitresseCache = null;
}

export async function chiffrer(plaintext: Uint8Array): Promise<string> {
  const cle = await chargerOuCreerCleMaitresse();
  const nonce = Crypto.getRandomBytes(NONCE_BYTES);
  const chiffre = gcm(cle, nonce).encrypt(plaintext);
  const enveloppe = new Uint8Array(nonce.length + chiffre.length);
  enveloppe.set(nonce, 0);
  enveloppe.set(chiffre, nonce.length);
  return base64Encode(enveloppe);
}

export class CoffreDechiffrementError extends Error {
  constructor() {
    super("DECHIFFREMENT_IMPOSSIBLE");
  }
}

export async function dechiffrer(enveloppeBase64: string): Promise<Uint8Array> {
  const cle = await chargerOuCreerCleMaitresse();
  const brut = base64Decode(enveloppeBase64);
  if (brut.length < NONCE_BYTES + AUTH_TAG_BYTES) {
    throw new CoffreDechiffrementError();
  }
  const nonce = brut.subarray(0, NONCE_BYTES);
  const chiffreEtTag = brut.subarray(NONCE_BYTES);
  try {
    return gcm(cle, nonce).decrypt(chiffreEtTag);
  } catch {
    throw new CoffreDechiffrementError();
  }
}

export async function chiffrerTexte(texte: string): Promise<string> {
  return chiffrer(new TextEncoder().encode(texte));
}

export async function dechiffrerTexte(enveloppeBase64: string): Promise<string> {
  return new TextDecoder().decode(await dechiffrer(enveloppeBase64));
}

/** Stocke une petite valeur simple (jamais un secret de taille importante)
 * dans le coffre matériel directement - pour l'adresse du PC, le PIN haché,
 * etc. (voir pairing/pairing.ts, verrouillage) - évite d'ajouter une
 * dépendance AsyncStorage distincte pour ces quelques valeurs. */
export async function stockerValeur(cle: string, valeur: string): Promise<void> {
  await SecureStore.setItemAsync(cle, valeur, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

export async function lireValeur(cle: string): Promise<string | null> {
  return SecureStore.getItemAsync(cle);
}

export async function supprimerValeur(cle: string): Promise<void> {
  await SecureStore.deleteItemAsync(cle);
}
