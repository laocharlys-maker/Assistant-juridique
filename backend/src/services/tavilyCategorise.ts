import { searchWeb, WebSearchResult } from "./tavily";

/**
 * Recherche Tavily par categorie d'origine, factorisee entre les deux
 * modules qui en ont besoin (jurisprudence/rechercheTavily.ts pour la
 * "Recherche de jurisprudence", recherche-juridique/rechercheTavily.ts pour
 * la "Recherche juridique" generale) - meme algorithme (appels cibles en
 * parallele, secours ouvert conditionnel, deduplication, logs), mais
 * chaque module garde ses PROPRES listes de domaines de confiance
 * (jamais partagees entre les deux : une base de decisions de justice
 * n'a pas vocation a etre confondue avec un site de textes officiels/
 * doctrine, voir le README de chaque module pour le detail).
 *
 * Chaque appel utilise searchWeb(), qui ne leve jamais d'exception (renvoie
 * [] en cas d'echec/absence de resultat, voir tavily.ts) : un echec sur une
 * categorie ne bloque donc ni les autres categories, ni la generation.
 */

export interface SourceWebCategorisee<Categorie extends string> extends WebSearchResult {
  categorie: Categorie | "ouvert";
}

const RESULTATS_MAX_PAR_CATEGORIE = 5;

/** Fusionne les resultats categorises en une liste plate, sans doublon
 * d'URL (une meme source peut ressortir de plusieurs categories si un
 * domaine figure dans plusieurs listes) - la premiere categorie a l'avoir
 * trouvee (dans l'ordre fourni, secours en dernier) est celle conservee. */
function fusionnerSansDoublons<Categorie extends string>(
  categories: { categorie: Categorie | "ouvert"; resultats: WebSearchResult[] }[]
): SourceWebCategorisee<Categorie>[] {
  const urlsVues = new Set<string>();
  const fusionnees: SourceWebCategorisee<Categorie>[] = [];
  for (const { categorie, resultats } of categories) {
    for (const resultat of resultats) {
      if (urlsVues.has(resultat.url)) continue;
      urlsVues.add(resultat.url);
      fusionnees.push({ ...resultat, categorie });
    }
  }
  return fusionnees;
}

export interface RechercheTavilyParCategoriesParams<Categorie extends string> {
  categories: { categorie: Categorie; domaines: string[] }[];
  /** Construit la requete Tavily pour une categorie donnee. */
  requetePourCategorie: (categorie: Categorie) => string;
  /** Requete utilisee pour l'appel de secours SANS restriction de domaine. */
  requeteOuverte: string;
  /** Nombre total de sources (toutes categories ciblees confondues, apres
   * deduplication) en-deca duquel l'appel de secours est declenche. */
  seuilSourcesMinimum: number;
  /** Prefixe des logs de couverture (ex: "jurisprudence-tavily",
   * "recherche-juridique-tavily") - jamais de donnee client, uniquement la
   * categorie et un compte. */
  prefixeLog: string;
}

export async function rechercherTavilyParCategories<Categorie extends string>(
  params: RechercheTavilyParCategoriesParams<Categorie>
): Promise<SourceWebCategorisee<Categorie>[]> {
  const { categories, requetePourCategorie, requeteOuverte, seuilSourcesMinimum, prefixeLog } = params;

  const resultatsCibles = await Promise.all(
    categories.map(async ({ categorie, domaines }) => ({
      categorie,
      resultats: await searchWeb(requetePourCategorie(categorie), RESULTATS_MAX_PAR_CATEGORIE, domaines),
    }))
  );

  const totalCible = resultatsCibles.reduce((total, c) => total + c.resultats.length, 0);

  // Secours SANS restriction de domaine - uniquement si la couverture des
  // domaines de confiance est insuffisante, pour ne jamais laisser une
  // requete legitime sans aucune matiere.
  const toutesCategories: { categorie: Categorie | "ouvert"; resultats: WebSearchResult[] }[] = [...resultatsCibles];
  if (totalCible < seuilSourcesMinimum) {
    const resultatsOuverts = await searchWeb(requeteOuverte, RESULTATS_MAX_PAR_CATEGORIE);
    toutesCategories.push({ categorie: "ouvert", resultats: resultatsOuverts });
  }

  const resume = toutesCategories.map((c) => `${c.categorie}=${c.resultats.length}`).join(", ");
  console.log(`[${prefixeLog}] sources par catégorie : ${resume}`);

  return fusionnerSansDoublons(toutesCategories);
}
