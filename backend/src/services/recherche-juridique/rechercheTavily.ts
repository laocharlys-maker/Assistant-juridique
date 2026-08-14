import { rechercherTavilyParCategories, SourceWebCategorisee } from "../tavilyCategorise";
import { CATEGORIES_DOMAINES_CONFIANCE, CategorieRechercheJuridique, SEUIL_SOURCES_MINIMUM } from "./domainesConfiance";

/**
 * Recherche Tavily du module "Recherche juridique" generale (droit, textes
 * de loi, doctrine - distincte de la "Recherche de jurisprudence", voir
 * services/jurisprudence/rechercheTavily.ts, domaines jamais partages).
 * Remplace l'ancien appel unique "domaines de confiance vs recherche
 * generale" (searchWebPrioritaire/RECHERCHE_JURIDIQUE_DOMAINES_CONFIANCE,
 * routes/webActions.ts) par un appel PARALLELE par categorie d'origine.
 * Algorithme factorise dans ../tavilyCategorise.ts, partage avec la
 * Recherche de jurisprudence - seules les listes de domaines different.
 */

export type { SourceWebCategorisee };

function requetePourCategorie(question: string, categorie: CategorieRechercheJuridique): string {
  switch (categorie) {
    case "benin":
      return `${question} droit Bénin texte de loi`;
    case "ohada":
      return `${question} droit OHADA`;
    case "doctrine_droit_compare":
      return `${question} doctrine droit comparé Afrique francophone`;
    case "france":
      return `${question} droit français`;
  }
}

/**
 * question : question de recherche juridique saisie par l'avocat (voir
 * form.question, routes/webActions.ts).
 */
export async function rechercherJuridiqueTavily(
  question: string
): Promise<SourceWebCategorisee<CategorieRechercheJuridique>[]> {
  return rechercherTavilyParCategories({
    categories: CATEGORIES_DOMAINES_CONFIANCE,
    requetePourCategorie: (categorie) => requetePourCategorie(question, categorie),
    requeteOuverte: question,
    seuilSourcesMinimum: SEUIL_SOURCES_MINIMUM,
    prefixeLog: "recherche-juridique-tavily",
  });
}
