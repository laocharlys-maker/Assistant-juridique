import { rechercherTavilyParCategories, SourceWebCategorisee } from "../tavilyCategorise";
import { CATEGORIES_DOMAINES_CONFIANCE, CategorieJuridique, SEUIL_SOURCES_MINIMUM } from "./domainesConfiance";

/**
 * Recherche Tavily du module "Recherche de jurisprudence", en complement du
 * RAG pgvector (JurisprudenceChunk, voir services/rag.ts - jamais touche
 * ici). Remplace, pour cette action uniquement, l'ancien appel unique
 * "domaines de confiance vs recherche generale" (searchWebPrioritaire,
 * routes/webActions.ts - toujours utilise tel quel par la Recherche
 * juridique generale, voir services/recherche-juridique/rechercheTavily.ts)
 * par un appel PARALLELE par categorie d'origine (Benin, OHADA/CCJA,
 * France, Afrique francophone elargie - voir domainesConfiance.ts), pour
 * prioriser les sources officielles/reconnues de chaque juridiction plutot
 * qu'une seule liste plate melangee. Algorithme factorise dans
 * ../tavilyCategorise.ts, partage avec la Recherche juridique.
 */

export type { SourceWebCategorisee };

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

/**
 * theme : sujet de la recherche de jurisprudence saisi par l'avocat (voir
 * form.theme, routes/webActions.ts).
 */
export async function rechercherJurisprudenceTavily(theme: string): Promise<SourceWebCategorisee<CategorieJuridique>[]> {
  return rechercherTavilyParCategories({
    categories: CATEGORIES_DOMAINES_CONFIANCE,
    requetePourCategorie: (categorie) => requetePourCategorie(theme, categorie),
    requeteOuverte: `${theme} jurisprudence Bénin OHADA`,
    seuilSourcesMinimum: SEUIL_SOURCES_MINIMUM,
    prefixeLog: "jurisprudence-tavily",
  });
}
