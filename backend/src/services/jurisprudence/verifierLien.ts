/**
 * Lot 13 - verification d'accessibilite d'un lien vers une decision de
 * justice, avant de l'afficher a l'avocat. `fetch` natif uniquement (pas de
 * nouvelle dependance HTTP) : HEAD d'abord (leger), repli sur GET si HEAD
 * echoue ou ne repond pas un statut concluant (certains serveurs bloquent
 * HEAD sans bloquer GET). Timeout court, cache en memoire de courte duree
 * (voir README-LOT13.md, "politique de cache").
 */

export interface VerificationLien {
  accessible: boolean;
  statut?: number;
  erreur?: string;
  verifieA: number;
}

const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h - "duree courte" (contrainte du prompt)

const cache = new Map<string, VerificationLien>();

function estExpire(resultat: VerificationLien): boolean {
  return Date.now() - resultat.verifieA > CACHE_TTL_MS;
}

function estStatutAccessible(statut: number): boolean {
  return statut >= 200 && statut < 400;
}

async function requeteAvecTimeout(url: string, method: "HEAD" | "GET"): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { method, redirect: "follow", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tenterRequete(url: string): Promise<VerificationLien> {
  try {
    const resHead = await requeteAvecTimeout(url, "HEAD");
    if (estStatutAccessible(resHead.status)) {
      return { accessible: true, statut: resHead.status, verifieA: Date.now() };
    }
    // HEAD a repondu mais avec un statut peu concluant (403, 405...) -
    // certains serveurs bloquent HEAD sans bloquer GET, on tente avant de
    // conclure a une erreur.
  } catch {
    // HEAD a echoue completement (timeout, refus de connexion...) - repli
    // sur GET ci-dessous avant de conclure.
  }

  try {
    const resGet = await requeteAvecTimeout(url, "GET");
    return { accessible: estStatutAccessible(resGet.status), statut: resGet.status, verifieA: Date.now() };
  } catch (error) {
    return {
      accessible: false,
      erreur: error instanceof Error ? error.message : "erreur réseau",
      verifieA: Date.now(),
    };
  }
}

/** Verifie qu'une URL est syntaxiquement valide et http(s) - jamais de
 * requete reseau vers autre chose qu'un lien web normal. */
function urlValide(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function verifierLien(url: string): Promise<VerificationLien> {
  const enCache = cache.get(url);
  if (enCache && !estExpire(enCache)) return enCache;

  if (!urlValide(url)) {
    const resultat: VerificationLien = { accessible: false, erreur: "URL invalide", verifieA: Date.now() };
    cache.set(url, resultat);
    return resultat;
  }

  const resultat = await tenterRequete(url);
  cache.set(url, resultat);
  return resultat;
}

/** Verifie plusieurs liens en parallele (dedupliques) - jamais en
 * sequence, pour ne pas faire dependre la latence totale du nombre de
 * decisions citees (contrainte de performance du prompt). */
export async function verifierLiens(urls: string[]): Promise<Map<string, VerificationLien>> {
  const uniques = [...new Set(urls)];
  const resultats = await Promise.all(uniques.map((url) => verifierLien(url)));
  return new Map(uniques.map((url, i) => [url, resultats[i]]));
}

/** Reserve aux tests - vide le cache en memoire entre deux scenarios. */
export function _viderCachePourTests(): void {
  cache.clear();
}
