import {
  genererPaireClesTelephone,
  clePubliqueVersBase64,
  clePubliqueDepuisBase64,
  clePriveeVersBase64,
  clePriveeDepuisBase64,
  calculerCleParGesee,
  chiffrerEnveloppe,
  construireAad,
} from "../crypto/protocol";
import { lireValeur, stockerValeur, supprimerValeur } from "../vault/vault";

/**
 * État de l'appairage de CET appareil avec un Aurore Desktop - stocké dans
 * le coffre (expo-secure-store, voir vault/vault.ts). Voir
 * docs/lot10/01-protocole.md pour le protocole complet.
 */

const CLES_STORE = {
  clePrivee: "aurore_mobile_cle_privee_v1",
  clePublique: "aurore_mobile_cle_publique_v1",
  clePubliquePc: "aurore_mobile_cle_publique_pc_v1",
  deviceId: "aurore_mobile_device_id_v1",
  adresse: "aurore_mobile_adresse_pc_v1",
  compteur: "aurore_mobile_compteur_requetes_v1",
};

export class QrExpireError extends Error {
  constructor() {
    super("QR_EXPIRE_OU_DEJA_UTILISE");
  }
}
export class PcIntrouvableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("PC_INTROUVABLE", options);
  }
}
export class SecretInvalideError extends Error {
  constructor() {
    super("SECRET_INVALIDE");
  }
}

export interface ContenuQr {
  v: number;
  pairingId: string;
  secret: string;
  clePubliquePC: string;
  adresses: string[];
}

/** Valide la forme du contenu scanné (pas de confiance aveugle dans ce
 * qu'un QR quelconque pourrait contenir). */
export function parserQr(contenuBrut: string): ContenuQr {
  let data: unknown;
  try {
    data = JSON.parse(contenuBrut);
  } catch {
    throw new Error("QR_ILLISIBLE");
  }
  const d = data as Partial<ContenuQr>;
  if (
    typeof d !== "object" ||
    d === null ||
    typeof d.pairingId !== "string" ||
    typeof d.secret !== "string" ||
    typeof d.clePubliquePC !== "string" ||
    !Array.isArray(d.adresses)
  ) {
    throw new Error("QR_ILLISIBLE");
  }
  return d as ContenuQr;
}

/**
 * Essaie chaque adresse du QR jusqu'à ce qu'une réponde - jamais de
 * balayage réseau plus large (contrainte du plan). Génère la paire de
 * clés PERMANENTE du téléphone à cette occasion (une seule fois, jamais
 * régénérée ensuite - la régénérer invaliderait l'appairage).
 */
export async function demanderAppairage(
  qr: ContenuQr,
  nomAppareil: string
): Promise<{ deviceId: string; statut: string }> {
  const paire = genererPaireClesTelephone();
  const corps = {
    pairingId: qr.pairingId,
    secret: qr.secret,
    clePubliqueTelephone: clePubliqueVersBase64(paire.clePubliqueRaw),
    nomAppareil,
  };

  let derniereErreurReseau: unknown = null;
  for (const adresse of qr.adresses) {
    try {
      const reponse = await fetch(`http://${adresse}/api/m/appairage/demander`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(corps),
      });
      if (reponse.status === 410) throw new QrExpireError();
      if (reponse.status === 401) throw new SecretInvalideError();
      if (!reponse.ok) {
        derniereErreurReseau = new Error(`HTTP ${reponse.status}`);
        continue;
      }
      const data = (await reponse.json()) as { deviceId: string; statut: string };

      await stockerValeur(CLES_STORE.clePrivee, clePriveeVersBase64(paire.clePriveeRaw));
      await stockerValeur(CLES_STORE.clePublique, clePubliqueVersBase64(paire.clePubliqueRaw));
      await stockerValeur(CLES_STORE.clePubliquePc, qr.clePubliquePC);
      await stockerValeur(CLES_STORE.deviceId, data.deviceId);
      await stockerValeur(CLES_STORE.adresse, adresse);
      await stockerValeur(CLES_STORE.compteur, "0");

      return data;
    } catch (error) {
      if (error instanceof QrExpireError || error instanceof SecretInvalideError) throw error;
      derniereErreurReseau = error;
      // Adresse suivante.
    }
  }
  throw new PcIntrouvableError(derniereErreurReseau instanceof Error ? { cause: derniereErreurReseau } : undefined);
}

export async function estAppaire(): Promise<boolean> {
  return (await lireValeur(CLES_STORE.deviceId)) !== null;
}

export async function oublierAppairage(): Promise<void> {
  await Promise.all(Object.values(CLES_STORE).map((cle) => supprimerValeur(cle)));
}

/** Adresse modifiable à la main dans les réglages (l'IP du PC peut changer
 * sur le réseau - contrainte explicite du plan). */
export async function definirAdressePc(adresse: string): Promise<void> {
  await stockerValeur(CLES_STORE.adresse, adresse);
}

interface ContexteAppareil {
  deviceId: string;
  adresse: string;
  clePrivee: Uint8Array;
  clePubliquePc: Uint8Array;
  compteur: number;
}

async function chargerContexte(): Promise<ContexteAppareil | null> {
  const [deviceId, adresse, clePriveeB64, clePubliquePcB64, compteurStr] = await Promise.all([
    lireValeur(CLES_STORE.deviceId),
    lireValeur(CLES_STORE.adresse),
    lireValeur(CLES_STORE.clePrivee),
    lireValeur(CLES_STORE.clePubliquePc),
    lireValeur(CLES_STORE.compteur),
  ]);
  if (!deviceId || !adresse || !clePriveeB64 || !clePubliquePcB64) return null;
  return {
    deviceId,
    adresse,
    clePrivee: clePriveeDepuisBase64(clePriveeB64),
    clePubliquePc: clePubliqueDepuisBase64(clePubliquePcB64),
    compteur: Number(compteurStr || "0"),
  };
}

// Serialise TOUS les appels a envoyerRequeteAuthentifiee, quel que soit
// l'appelant (envoi d'un element, ping de testerConnexion, synchronisation
// des dossiers...) - le compteur anti-rejeu est partage par appareil, pas
// par ecran. Sans ce verrou global, deux appels concurrents (ex. le ping
// periodique de l'accueil, jamais arrete puisque l'ecran reste monte sous
// la pile de navigation, pendant l'envoi d'un enregistrement depuis un
// autre ecran) lisent/incrementent le meme compteur en course, et le
// serveur rejette l'un des deux comme rejoue (voir
// middleware/mobileDeviceAuth.ts). Un verrou par-clientId (cote
// sync/elements.ts) ne suffit pas : il ne protege pas contre un appelant
// totalement different comme le ping.
let verrouRequete: Promise<unknown> = Promise.resolve();

export function envoyerRequeteAuthentifiee<T>(chemin: string, payload: unknown): Promise<T> {
  const tache = verrouRequete.then(() => envoyerRequeteAuthentifieeSansVerrou<T>(chemin, payload));
  verrouRequete = tache.catch(() => undefined);
  return tache;
}

/**
 * Envoie une requête chiffrée authentifiée vers une route /api/m/* - voir
 * docs/lot10/01-protocole.md section 4. Incrémente et persiste le compteur
 * AVANT l'envoi (jamais après) : si l'appli est tuée juste après l'envoi
 * mais avant la persistance, mieux vaut "sauter" un numéro de séquence
 * (sans conséquence, le serveur accepte n'importe quelle valeur strictement
 * croissante) que risquer de renvoyer deux fois le même compteur après un
 * redémarrage (ce que le serveur rejetterait comme un rejeu).
 */
async function envoyerRequeteAuthentifieeSansVerrou<T>(chemin: string, payload: unknown): Promise<T> {
  const contexte = await chargerContexte();
  if (!contexte) throw new Error("APPAREIL_NON_APPAIRE");

  const compteur = contexte.compteur + 1;
  await stockerValeur(CLES_STORE.compteur, String(compteur));

  const sk = calculerCleParGesee(contexte.clePrivee, contexte.clePubliquePc, contexte.deviceId);
  const horodatage = Date.now();
  const aad = construireAad(contexte.deviceId, compteur, horodatage);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload ?? {}));
  const enveloppe = chiffrerEnveloppe(sk, plaintext, aad);

  const reponse = await fetch(`http://${contexte.adresse}${chemin}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: contexte.deviceId, compteur, horodatage, enveloppe }),
  });

  if (!reponse.ok) {
    const corpsErreur = await reponse.json().catch(() => ({ error: `HTTP ${reponse.status}` }));
    const detailsTexte = Array.isArray(corpsErreur.details)
      ? ` (${corpsErreur.details.map((d: { path?: unknown[]; message?: string }) => `${(d.path || []).join(".")}: ${d.message}`).join(", ")})`
      : "";
    const erreur = new Error(`${corpsErreur.error || `HTTP ${reponse.status}`}${detailsTexte}`);
    (erreur as Error & { status?: number }).status = reponse.status;
    throw erreur;
  }

  // La reponse elle-meme n'est PAS chiffree par le serveur dans ce lot
  // (donnees non sensibles : statut, liste de dossiers deja visibles par
  // l'utilisateur authentifie du cote PC) - a revisiter si un futur lot
  // transporte quelque chose de plus sensible en reponse.
  return reponse.json() as Promise<T>;
}

export async function testerConnexion(): Promise<boolean> {
  try {
    const reponse = await envoyerRequeteAuthentifiee<{ ok: boolean }>("/api/m/ping", {});
    return reponse.ok === true;
  } catch {
    return false;
  }
}

