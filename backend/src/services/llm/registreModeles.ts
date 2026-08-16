import fs from "node:fs";
import path from "node:path";
import { secretsDir } from "../../database/portablePaths";

/**
 * Registre centralise des modeles LLM (Lot 22) : chaque fournisseur a un
 * modele "principal" (celui utilise normalement) et un modele "repli"
 * (bascule automatique si le principal est retire/renomme par le
 * fournisseur - voir appelerAvecRepli plus bas). Avant ce lot, ces noms
 * etaient des constantes codees en dur dans gemini.ts/anthropic.ts/groq.ts -
 * corriger un modele retire (deja arrive avec Groq/Llama) exigeait une
 * reinstallation complete via l'auto-updater (Lot 8) chez chaque cabinet.
 *
 * Deux niveaux de protection, independants l'un de l'autre :
 * - Local (toujours actif, y compris hors ligne) : le repli automatique
 *   ci-dessous, et les valeurs par defaut codees en dur.
 * - Distant (necessite aurore-licence-service deploye - voir README-LOT22.md,
 *   NON fait a ce jour) : appliquerConfigurationDistante(), appelee par
 *   licenceManager.ts a chaque phone-home reussi qui contient le champ
 *   modelesLlmActifs, permet a AzoMedIA de changer le modele principal actif
 *   pour tous les cabinets sans redeploiement ni reinstallation.
 */

export type FournisseurLlm = "gemini" | "anthropic" | "groq";

interface ModelesFournisseur {
  principal: string;
  repli: string;
}

/**
 * Valeurs par defaut codees en dur (etat au 2026-08-16 - voir gemini.ts/
 * anthropic.ts/groq.ts avant ce lot pour l'historique). Utilisees tant
 * qu'aucune configuration distante n'a ete recue (voir cacheDistant plus
 * bas). Le modele de "repli" n'est JAMAIS ecrasable a distance (voir
 * appliquerConfigurationDistante) : c'est le filet de securite qui doit
 * rester valide meme sans connexion ni licence-service deploye - si un
 * fournisseur venait a le retirer aussi, seule une mise a jour de ce fichier
 * (nouveau build) peut le corriger.
 */
const MODELES_PAR_DEFAUT: Record<FournisseurLlm, ModelesFournisseur> = {
  gemini: { principal: "gemini-3.6-flash", repli: "gemini-2.5-flash" },
  anthropic: { principal: "claude-sonnet-5", repli: "claude-haiku-4-5-20251001" },
  groq: { principal: "llama-3.3-70b-versatile", repli: "llama-3.1-8b-instant" },
};

const FOURNISSEURS = Object.keys(MODELES_PAR_DEFAUT) as FournisseurLlm[];

// ============================================================================
// Cache de la configuration distante (persiste sur disque - voir point 6 du
// prompt Lot22 : en mode licence "manuel", le registre doit rester "fige sur
// les valeurs codees en dur OU LE DERNIER CACHE CONNU", jamais bloque en
// attente d'un appel reseau).
// ============================================================================

type CacheDistant = Partial<Record<FournisseurLlm, string>>;

function cheminCacheDistant(): string {
  return path.join(secretsDir(), "registre-modeles-distant.json");
}

function lireCacheDistantDisque(): CacheDistant {
  try {
    const brut: unknown = JSON.parse(fs.readFileSync(cheminCacheDistant(), "utf8"));
    if (!brut || typeof brut !== "object") return {};
    const resultat: CacheDistant = {};
    for (const fournisseur of FOURNISSEURS) {
      const valeur = (brut as Record<string, unknown>)[fournisseur];
      if (typeof valeur === "string" && valeur.trim()) {
        resultat[fournisseur] = valeur;
      }
    }
    return resultat;
  } catch {
    return {};
  }
}

function ecrireCacheDistantDisque(cache: CacheDistant): void {
  fs.mkdirSync(secretsDir(), { recursive: true });
  fs.writeFileSync(cheminCacheDistant(), JSON.stringify(cache, null, 2));
}

/** Charge paresseusement depuis le disque (une seule fois par process) plutot
 * qu'a chaque appel : ce cache est lu sur le chemin chaud (chaque
 * extractAction/redact des 3 providers). */
let cacheDistantMemoire: CacheDistant | null = null;
function cacheDistant(): CacheDistant {
  if (cacheDistantMemoire === null) {
    cacheDistantMemoire = lireCacheDistantDisque();
  }
  return cacheDistantMemoire;
}

export function getModelePrincipal(fournisseur: FournisseurLlm): string {
  return cacheDistant()[fournisseur] ?? MODELES_PAR_DEFAUT[fournisseur].principal;
}

export function getModeleRepli(fournisseur: FournisseurLlm): string {
  return MODELES_PAR_DEFAUT[fournisseur].repli;
}

/**
 * Applique une configuration recue via phone-home (licenceManager.ts,
 * champ modelesLlmActifs) : met a jour le cache en memoire ET sur disque
 * (pour survivre a un redemarrage sans reseau disponible). N'ecrit sur
 * disque que si au moins une valeur a reellement change, pour ne pas
 * re-ecrire ce fichier a chaque phone-home hebdomadaire sans raison. Cles
 * inconnues (fournisseur non gere) ou valeurs vides silencieusement
 * ignorees plutot que rejetees : coherent avec le schema non strict de
 * licenceManager.ts (un serveur plus recent pourrait envoyer un fournisseur
 * pas encore gere par ce client).
 */
export function appliquerConfigurationDistante(config: Record<string, string | undefined>): void {
  const nouveauCache: CacheDistant = { ...cacheDistant() };
  let modifie = false;
  for (const fournisseur of FOURNISSEURS) {
    const valeur = config[fournisseur];
    if (typeof valeur === "string" && valeur.trim() && valeur !== nouveauCache[fournisseur]) {
      nouveauCache[fournisseur] = valeur;
      modifie = true;
    }
  }
  if (!modifie) return;

  cacheDistantMemoire = nouveauCache;
  try {
    ecrireCacheDistantDisque(nouveauCache);
  } catch (error) {
    console.warn(
      "[registreModeles] echec d'ecriture du cache distant sur disque (configuration appliquee en memoire pour cette session uniquement) :",
      error instanceof Error ? error.message : error
    );
  }
  console.log(`[registreModeles] configuration distante des modeles LLM appliquee : ${JSON.stringify(nouveauCache)}`);
}

/** Reserve aux tests : force une relecture du disque au prochain appel. */
export function _reinitialiserCachePourTests(): void {
  cacheDistantMemoire = null;
}

// ============================================================================
// Repli automatique (point 3 du prompt Lot22) - detection d'une erreur
// caracteristique d'un modele retire/renomme, jamais d'une cle invalide ou
// d'un quota epuise.
// ============================================================================

function statutDe(erreur: unknown): number | undefined {
  if (erreur && typeof erreur === "object" && "status" in erreur) {
    const valeur = (erreur as { status?: unknown }).status;
    return typeof valeur === "number" ? valeur : undefined;
  }
  return undefined;
}

function messageDe(erreur: unknown): string {
  return erreur instanceof Error ? erreur.message : String(erreur);
}

/**
 * Motifs textuels caracteristiques d'un modele retire/renomme chez Gemini
 * (ex: "is not found for API version ... or is not supported for
 * GenerateContent"), Anthropic (type d'erreur "not_found_error") et Groq/
 * OpenAI-compatible (code "model_decommissioned", message "does not
 * exist"). Verifie EN PLUS d'un statut HTTP 404 ou 400 (jamais 401/403 - cle
 * invalide - ni 429 - quota epuise) pour ne jamais declencher de repli sur
 * un 400 generique sans rapport avec le nom du modele (ex: schema d'outil
 * invalide).
 */
const MOTIF_MODELE_INDISPONIBLE =
  /model[_ ]?(not[_ ]?found|decommissioned)|not[_ ]?found|does not exist|n'existe pas|is not supported for/i;

export function isErreurModeleIndisponible(erreur: unknown): boolean {
  const statut = statutDe(erreur);
  if (statut !== 404 && statut !== 400) return false;
  return MOTIF_MODELE_INDISPONIBLE.test(messageDe(erreur));
}

/**
 * Enrobe un appel fournisseur avec le repli automatique : essaie d'abord le
 * modele principal ; si l'echec est caracteristique d'un modele retire/
 * renomme (isErreurModeleIndisponible), reessaie UNE SEULE FOIS avec le
 * modele de repli du meme fournisseur avant d'abandonner. Toute autre
 * erreur (cle API invalide, quota epuise, panne reseau transitoire deja
 * geree par withTransientRetry en amont...) est propagee immediatement, sans
 * repli - c'est le contrat impose par le prompt Lot22 : ne jamais masquer
 * une vraie erreur de cle/quota.
 */
export async function appelerAvecRepli<T>(
  fournisseur: FournisseurLlm,
  appel: (nomModele: string) => Promise<T>
): Promise<T> {
  const principal = getModelePrincipal(fournisseur);
  try {
    return await appel(principal);
  } catch (erreur) {
    if (!isErreurModeleIndisponible(erreur)) {
      throw erreur;
    }

    const repli = getModeleRepli(fournisseur);
    if (repli === principal) {
      throw erreur;
    }

    console.warn(
      `[registreModeles] modele "${principal}" indisponible pour ${fournisseur} (${messageDe(erreur)}) - repli automatique sur "${repli}".`
    );
    return await appel(repli);
  }
}
