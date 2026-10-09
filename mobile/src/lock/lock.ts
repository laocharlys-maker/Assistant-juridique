import * as Crypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";
import { sha256 } from "@noble/hashes/sha2.js";
import { lireValeur, stockerValeur, supprimerValeur } from "../vault/vault";

/**
 * Verrouillage de l'application (Prompt 3, objectif C) - PIN obligatoire à
 * la première utilisation, biométrie en option, verrouillage automatique
 * après un délai réglable.
 *
 * IMPORTANT (limite à documenter honnêtement, jamais une promesse
 * excessive - voir Prompt 7) : le PIN protège l'ACCÈS À L'INTERFACE de
 * l'app (rien ne s'affiche sans lui), mais la clé maîtresse de chiffrement
 * (vault/vault.ts) est protégée par le coffre matériel du système
 * (Android Keystore via expo-secure-store), PAS dérivée du PIN. Casser le
 * PIN ne donne donc jamais directement les données en clair à qui n'a pas
 * aussi déverrouillé l'appareil au niveau du système - mais le PIN n'est
 * pas non plus une seconde couche cryptographique indépendante. C'est le
 * même modèle que la plupart des apps mobiles grand public avec "verrou
 * d'application" (Signal, WhatsApp...).
 */

const PIN_HASH_STORE = "aurore_mobile_pin_hash_v1";
const PIN_SEL_STORE = "aurore_mobile_pin_sel_v1";
const DELAI_VERROUILLAGE_STORE = "aurore_mobile_delai_verrouillage_minutes_v1";
const DELAI_PAR_DEFAUT_MINUTES = 2;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function pinDejaConfigure(): Promise<boolean> {
  return (await lireValeur(PIN_HASH_STORE)) !== null;
}

export async function configurerPin(pin: string): Promise<void> {
  if (!/^\d{4,8}$/.test(pin)) {
    throw new Error("PIN_INVALIDE");
  }
  const sel = Crypto.getRandomBytes(16);
  const hash = sha256(new TextEncoder().encode(bytesToHex(sel) + pin));
  await stockerValeur(PIN_SEL_STORE, bytesToHex(sel));
  await stockerValeur(PIN_HASH_STORE, bytesToHex(hash));
}

export async function verifierPin(pin: string): Promise<boolean> {
  const selHex = await lireValeur(PIN_SEL_STORE);
  const hashAttendu = await lireValeur(PIN_HASH_STORE);
  if (!selHex || !hashAttendu) return false;
  const hashCalcule = bytesToHex(sha256(new TextEncoder().encode(selHex + pin)));
  // Comparaison en temps constant - un timing attack sur un PIN local a un
  // impact tres limite (deja protege par le verrouillage systeme), mais
  // meme reflexe que le reste du protocole (voir backend crypto.ts).
  if (hashCalcule.length !== hashAttendu.length) return false;
  let diff = 0;
  for (let i = 0; i < hashCalcule.length; i++) {
    diff |= hashCalcule.charCodeAt(i) ^ hashAttendu.charCodeAt(i);
  }
  return diff === 0;
}

export async function reinitialiserPin(): Promise<void> {
  await supprimerValeur(PIN_SEL_STORE);
  await supprimerValeur(PIN_HASH_STORE);
}

export async function biometrieDisponible(): Promise<boolean> {
  const materielPresent = await LocalAuthentication.hasHardwareAsync();
  if (!materielPresent) return false;
  const enregistree = await LocalAuthentication.isEnrolledAsync();
  return enregistree;
}

export async function authentifierParBiometrie(): Promise<boolean> {
  const resultat = await LocalAuthentication.authenticateAsync({
    promptMessage: "Déverrouiller Aurore Mobile",
    cancelLabel: "Utiliser le code PIN",
    disableDeviceFallback: true,
  });
  return resultat.success;
}

export async function lireDelaiVerrouillageMinutes(): Promise<number> {
  const valeur = await lireValeur(DELAI_VERROUILLAGE_STORE);
  return valeur ? Number(valeur) : DELAI_PAR_DEFAUT_MINUTES;
}

export async function definirDelaiVerrouillageMinutes(minutes: number): Promise<void> {
  await stockerValeur(DELAI_VERROUILLAGE_STORE, String(minutes));
}

/**
 * Détermine si l'app doit se reverrouiller, à partir de l'horodatage de
 * mise en arrière-plan (géré par l'appelant via AppState - voir
 * App.tsx) et du délai réglé.
 */
export async function doitSeVerrouiller(horodatageMiseEnArrierePlan: number | null): Promise<boolean> {
  if (horodatageMiseEnArrierePlan === null) return false;
  const delaiMinutes = await lireDelaiVerrouillageMinutes();
  return Date.now() - horodatageMiseEnArrierePlan >= delaiMinutes * 60 * 1000;
}
