import { searchWeb, WebSearchResult } from "../tavily";
import { CATEGORIES_DOMAINES_CONFIANCE, CategorieJuridique, SEUIL_SOURCES_MINIMUM } from "./domainesConfiance";

/**
 * Recherche Tavily du module "Recherche de jurisprudence", en complement du
 * RAG pgvector (JurisprudenceChunk, voir services/rag.ts - jamais touche
 * ici). Remplace, pour cette action uniquement, l'ancien appel unique
 * "domaines de confiance vs recherche generale" (searchWebPrioritaire,
 * routes/webActions.ts - toujours utilise tel quel par la Recherche
 * juridique generale, hors perimetre) par un appel PARALLELE par categorie
 * d'origine (Benin, OHADA/CCJA, France, Afrique francophone elargie), pour
 * prioriser les sources officielles/reconnues de chaque juridiction plutot
 * qu'une seule liste plate melangee.
 *
 * Chaque appel utilise searchWeb(), qui ne leve jamais d'exception (renvoie
 * [] en cas d'echec/absence de resultat, voir tavily.ts) : un echec sur une
 * categorie ne bloque donc ni les autres categories, ni la generation.
 */

export interface SourceWebCategorisee extends WebSearchResult {
  categorie: CategorieJuridique | "ouvert";
}

const RESULTATS_MAX_PAR_CATEGORIE = 5;

function requetePourCategorie(theme: string, categorie: CategorieJuridique): string {
  switch (categorie) {
    case "benin":
      return `${theme} jurisprudence Bénin`;
    case "ohada":
      return `${theme} jurisprudence OHADA CCJA`;
    case "france":
      return `${theme} jurisprudence France Cour de cassation Conseil d'État`;
    case "afrique_francophone":
      return `${theme} jurisprudence Afrique francophone`;
  }
}

/** Fusionne les resultats categorises en une liste plate, sans doublon
 * d'URL (une meme decision peut ressortir de plusieurs categories - ex.
 * juricaf.org est a la fois dans "ohada" et "afrique_francophone") - la
 * premiere categorie a l'avoir trouvee (dans l'ordre de CATEGORIES_
 * DOMAINES_CONFIANCE, secours en dernier) est celle conservee. */
function fusionnerSansDoublons(
  categories: { categorie: CategorieJuridique | "ouvert"; resultats: WebSearchResult[] }[]
): SourceWebCategorisee[] {
  const urlsVues = new Set<string>();
  const fusionnees: SourceWebCategorisee[] = [];
  for (const { categorie, resultats } of categories) {
    for (const resultat of resultats) {
      if (urlsVues.has(resultat.url)) continue;
      urlsVues.add(resultat.url);
      fusionnees.push({ ...resultat, categorie });
    }
  }
  return fusionnees;
}

/** Journalise le nombre de sources obtenues par categorie (jamais de
 * donnee client - uniquement la categorie et un compte), pour permettre au
 * cabinet de suivre la couverture reelle des domaines de confiance dans le
 * temps. */
function loggerCouverture(categories: { categorie: CategorieJuridique | "ouvert"; resultats: WebSearchResult[] }[]): void {
  const resume = categories.map((c) => `${c.categorie}=${c.resultats.length}`).join(", ");
  console.log(`[jurisprudence-tavily] sources par catégorie : ${resume}`);
}

/**
 * theme : sujet de la recherche de jurisprudence saisi par l'avocat (voir
 * form.theme, routes/webActions.ts).
 */
export async function rechercherJurisprudenceTavily(theme: string): Promise<SourceWebCategorisee[]> {
  const resultatsCibles = await Promise.all(
    CATEGORIES_DOMAINES_CONFIANCE.map(async ({ categorie, domaines }) => ({
      categorie,
      resultats: await searchWeb(requetePourCategorie(theme, categorie), RESULTATS_MAX_PAR_CATEGORIE, domaines),
    }))
  );

  const totalCible = resultatsCibles.reduce((total, c) => total + c.resultats.length, 0);

  // Secours SANS restriction de domaine - uniquement si la couverture des
  // domaines de confiance est insuffisante, pour ne jamais laisser une
  // requete legitime sans aucune matiere.
  const categories: { categorie: CategorieJuridique | "ouvert"; resultats: WebSearchResult[] }[] = [...resultatsCibles];
  if (totalCible < SEUIL_SOURCES_MINIMUM) {
    const resultatsOuverts = await searchWeb(`${theme} jurisprudence Bénin OHADA`, RESULTATS_MAX_PAR_CATEGORIE);
    categories.push({ categorie: "ouvert", resultats: resultatsOuverts });
  }

  loggerCouverture(categories);
  return fusionnerSansDoublons(categories);
}
