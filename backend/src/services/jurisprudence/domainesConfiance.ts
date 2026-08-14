/**
 * Domaines de confiance pour la recherche Tavily du module "Recherche de
 * jurisprudence" (fiche de jurisprudence, distincte de la "Recherche
 * juridique" generale - voir RECHERCHE_JURIDIQUE_DOMAINES_CONFIANCE dans
 * routes/webActions.ts, non concernee par ce fichier).
 *
 * Une liste par categorie d'origine (plutot qu'une seule liste plate
 * melangee) pour permettre un appel Tavily cible par categorie (voir
 * rechercheTavily.ts), chacun pouvant echouer/ne rien trouver
 * independamment des autres. Ajustable ici sans toucher a la logique
 * d'appel.
 */

export type CategorieJuridique = "benin" | "ohada" | "france" | "afrique_francophone";

export const DOMAINES_CONFIANCE_BENIN = ["coursupreme.bj", "juricaf.org", "ahjucaf.org", "droit-afrique.com"];

export const DOMAINES_CONFIANCE_OHADA = ["ohada.org", "ohada.com", "jurisprudence-ohada.com", "juricaf.org"];

export const DOMAINES_CONFIANCE_FRANCE = [
  "legifrance.gouv.fr",
  "courdecassation.fr",
  "conseil-etat.fr",
  "conseil-constitutionnel.fr",
];

// Fallback si peu de resultats Benin/OHADA - couverture plus large de la
// francophonie africaine, memes bases (juricaf/ahjucaf) sans restriction de
// pays precis.
export const DOMAINES_CONFIANCE_AFRIQUE_FRANCOPHONE = ["juricaf.org", "ahjucaf.org"];

export const CATEGORIES_DOMAINES_CONFIANCE: { categorie: CategorieJuridique; domaines: string[] }[] = [
  { categorie: "benin", domaines: DOMAINES_CONFIANCE_BENIN },
  { categorie: "ohada", domaines: DOMAINES_CONFIANCE_OHADA },
  { categorie: "france", domaines: DOMAINES_CONFIANCE_FRANCE },
  { categorie: "afrique_francophone", domaines: DOMAINES_CONFIANCE_AFRIQUE_FRANCOPHONE },
];

// Nombre total de sources (toutes categories ciblees confondues, apres
// deduplication) en-deca duquel un appel Tavily de secours SANS restriction
// de domaine est declenche, pour ne jamais laisser une requete legitime
// sans aucune matiere faute de couverture des domaines de confiance.
// Modifiable via JURISPRUDENCE_SEUIL_SOURCES_MINIMUM sans redeploiement.
export const SEUIL_SOURCES_MINIMUM = Number(process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM ?? 3);
