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
  // "adresse" = derniere adresse qui a fonctionne (toujours essayee en
  // premier, voir chargerContexte/adressesTriees) ; "adressesConnues" =
  // toutes les adresses jamais vues (celles du QR d'appairage + celles
  // ajoutees manuellement dans Reglages) - Prompt 6 objectif B : l'IP du PC
  // change regulierement sur un reseau Wifi domestique/cabinet, reessayer
  // les autres adresses connues avant d'afficher "Aurore introuvable"
  // evite une intervention manuelle a chaque changement.
  adresse: "aurore_mobile_adresse_pc_v1",
  adressesConnues: "aurore_mobile_adresses_connues_v1",
  compteur: "aurore_mobile_compteur_requetes_v1",
};

export class QrExpireError extends Error {
  constructor() {
    super("QR_EXPIRE_OU_DEJA_UTILISE");
  }
}
export class PcIntrouvableError extends Error {
  /** Adresses essayées (affichées à l'écran pour aider au diagnostic). */
  adresses: string[];
  constructor(options?: { cause?: unknown; adresses?: string[] }) {
    super("PC_INTROUVABLE", options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.adresses = options?.adresses ?? [];
  }
}

// Une adresse injoignable (IP d'une carte virtuelle, pare-feu qui ignore les
// paquets...) ne répond jamais : sans délai maximal, Android attend la fin du
// timeout TCP (souvent plus d'une minute) POUR CHAQUE adresse du QR avant
// d'afficher "Aurore introuvable". Réservé à l'appairage (requête minuscule) :
// ne jamais l'appliquer aux envois d'enregistrements/scans, qui peuvent
// légitimement durer plus longtemps sur un gros fichier.
const DELAI_APPAIRAGE_PAR_ADRESSE_MS = 5000;

async function fetchAvecDelai(url: string, init: RequestInit, delaiMs: number): Promise<Response> {
  const controleur = new AbortController();
  const minuterie = setTimeout(() => controleur.abort(), delaiMs);
  try {
    return await fetch(url, { ...init, signal: controleur.signal });
  } finally {
    clearTimeout(minuterie);
  }
}
export class SecretInvalideError extends Error {
  constructor() {
    super("SECRET_INVALIDE");
  }
}
/** Prompt 6, objectif E - appareil révoqué côté PC (403) : échec permanent,
 * jamais retenté automatiquement (voir sync/elements.ts). */
export class AppareilRevoqueError extends Error {
  constructor() {
    super("APPAREIL_REVOQUE");
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
      const reponse = await fetchAvecDelai(
        `http://${adresse}/api/m/appairage/demander`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(corps),
        },
        DELAI_APPAIRAGE_PAR_ADRESSE_MS
      );
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
      // Toutes les adresses du QR, pas seulement celle qui a repondu en
      // premier - si l'IP qui a fonctionne aujourd'hui change demain, une
      // des autres a peut-etre une IP fixe ou est restee stable (voir
      // adressesTriees ci-dessous).
      await stockerValeur(CLES_STORE.adressesConnues, JSON.stringify(qr.adresses));
      await stockerValeur(CLES_STORE.compteur, "0");

      return data;
    } catch (error) {
      if (error instanceof QrExpireError || error instanceof SecretInvalideError) throw error;
      derniereErreurReseau = error;
      // Adresse suivante.
    }
  }
  throw new PcIntrouvableError({
    ...(derniereErreurReseau instanceof Error ? { cause: derniereErreurReseau } : {}),
    adresses: qr.adresses,
  });
}

export async function estAppaire(): Promise<boolean> {
  return (await lireValeur(CLES_STORE.deviceId)) !== null;
}

export async function oublierAppairage(): Promise<void> {
  await Promise.all(Object.values(CLES_STORE).map((cle) => supprimerValeur(cle)));
}

/** Adresse modifiable à la main dans les réglages (l'IP du PC peut changer
 * sur le réseau - contrainte explicite du plan) - ajoutée aux adresses
 * connues plutôt que de remplacer la liste, pour ne pas perdre les autres
 * si celle-ci ne fonctionne plus demain. */
export async function definirAdressePc(adresse: string): Promise<void> {
  await stockerValeur(CLES_STORE.adresse, adresse);
  const connues = await chargerAdressesConnues();
  if (!connues.includes(adresse)) {
    await stockerValeur(CLES_STORE.adressesConnues, JSON.stringify([adresse, ...connues]));
  }
}

async function chargerAdressesConnues(): Promise<string[]> {
  const brut = await lireValeur(CLES_STORE.adressesConnues);
  if (!brut) return [];
  try {
    const liste = JSON.parse(brut);
    return Array.isArray(liste) ? liste.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/** Adresses à essayer, dans l'ORDRE : la dernière qui a fonctionné
 * d'abord (Prompt 6, objectif B), puis les autres adresses connues -
 * jamais de balayage réseau plus large que cette liste connue. */
async function adressesTriees(adressePrioritaire: string): Promise<string[]> {
  const connues = await chargerAdressesConnues();
  return [adressePrioritaire, ...connues.filter((a) => a !== adressePrioritaire)];
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
  const corps = JSON.stringify({ deviceId: contexte.deviceId, compteur, horodatage, enveloppe });

  // Prompt 6, objectif B : essaie la derniere adresse qui a fonctionne
  // d'abord, puis les autres adresses connues (jamais de balayage reseau
  // plus large) - une seule enveloppe chiffree construite ci-dessus, le
  // meme corps est simplement poste a chaque adresse candidate jusqu'a ce
  // qu'une reponde.
  const adresses = await adressesTriees(contexte.adresse);
  let derniereErreurReseau: unknown = null;
  for (const adresse of adresses) {
    let reponse: Response;
    try {
      reponse = await fetch(`http://${adresse}${chemin}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: corps,
      });
    } catch (error) {
      derniereErreurReseau = error;
      continue; // Adresse injoignable - essaie la suivante.
    }

    // Une reponse HTTP (meme une erreur) prouve qu'on a bien atteint
    // Aurore a cette adresse - on ne tente jamais une autre adresse apres
    // ca, et on la retient comme nouvelle adresse prioritaire si elle a
    // change (voir definirAdressePc/demanderAppairage pour l'ecriture
    // initiale).
    if (adresse !== contexte.adresse) await stockerValeur(CLES_STORE.adresse, adresse);

    if (!reponse.ok) {
      const corpsErreur = await reponse.json().catch(() => ({ error: `HTTP ${reponse.status}` }));
      const detailsTexte = Array.isArray(corpsErreur.details)
        ? ` (${corpsErreur.details.map((d: { path?: unknown[]; message?: string }) => `${(d.path || []).join(".")}: ${d.message}`).join(", ")})`
        : "";
      if (reponse.status === 403) throw new AppareilRevoqueError();
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

  throw new PcIntrouvableError(derniereErreurReseau instanceof Error ? { cause: derniereErreurReseau } : undefined);
}

export async function testerConnexion(): Promise<boolean> {
  try {
    const reponse = await envoyerRequeteAuthentifiee<{ ok: boolean }>("/api/m/ping", {});
    return reponse.ok === true;
  } catch {
    return false;
  }
}

export type EtatConnexion = "connecte" | "introuvable" | "revoque";

export interface InfosConnexion {
  etat: EtatConnexion;
  nomUtilisateur: string | null;
  role: string | null;
}

/** Même ping que testerConnexion, mais distingue "Aurore introuvable sur
 * ce réseau" d'un appareil révoqué (Prompt 6, objectif E) - l'accueil
 * affiche un message clair et différent dans ce dernier cas, plutôt que le
 * message réseau générique. Renvoie aussi le nom/rôle du titulaire de
 * l'appareil (déjà inclus dans la réponse du ping côté serveur) pour
 * l'affichage "Bienvenue <nom>", sans appel réseau supplémentaire. */
export async function verifierEtatConnexion(): Promise<InfosConnexion> {
  try {
    const reponse = await envoyerRequeteAuthentifiee<{ ok: boolean; nomUtilisateur?: string | null; role?: string | null }>(
      "/api/m/ping",
      {}
    );
    return {
      etat: reponse.ok === true ? "connecte" : "introuvable",
      nomUtilisateur: reponse.nomUtilisateur ?? null,
      role: reponse.role ?? null,
    };
  } catch (erreur) {
    return {
      etat: erreur instanceof AppareilRevoqueError ? "revoque" : "introuvable",
      nomUtilisateur: null,
      role: null,
    };
  }
}

