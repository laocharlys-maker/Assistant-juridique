/**
 * Domaines de confiance pour la recherche Tavily du module "Recherche
 * juridique" generale (questions de droit, textes de loi, doctrine).
 *
 * DELIBEREMENT DISTINCT des domaines de la "Recherche de jurisprudence"
 * (voir services/jurisprudence/domainesConfiance.ts) : ce module cherche
 * des TEXTES OFFICIELS et de la DOCTRINE (lois, decrets, journal officiel,
 * articles de doctrine), jamais des DECISIONS DE JUSTICE - les deux ne
 * doivent jamais partager une meme liste de domaines de confiance, au
 * risque de faire remonter une base de jurisprudence (JURICAF, CCJA...)
 * pour une question de droit general qui n'appelle aucune decision
 * particuliere, ou inversement.
 *
 * Une liste par categorie (plutot qu'une seule liste plate) pour permettre
 * un appel Tavily cible par categorie (voir rechercheTavily.ts), chacun
 * pouvant echouer/ne rien trouver independamment des autres. Ajustable ici
 * sans toucher a la logique d'appel.
 */

export type CategorieRechercheJuridique = "benin" | "ohada" | "doctrine_droit_compare" | "france";

// Textes officiels beninois : journal officiel, legislation consolidee,
// site de la Presidence - jamais une base de decisions de justice.
export const DOMAINES_BENIN = ["sgg.gouv.bj", "journalofficiel.gouv.bj", "legis.cdij.bj", "presidence.bj"];

export const DOMAINES_OHADA = ["ohada.org", "ohada.com"];

// Doctrine et droit compare (Afrique francophone) - articles/analyses,
// jamais des arrets.
export const DOMAINES_DOCTRINE_DROIT_COMPARE = ["droit-afrique.com", "cairn.info"];

// France : droit compare uniquement - le prompt systeme (voir
// RECHERCHE_JURIDIQUE_SYSTEM_PROMPT, prompts/webRedaction.ts) impose
// explicitement de signaler qu'un texte francais peut ne pas s'appliquer
// tel quel au Benin, jamais de le presenter comme du droit beninois.
export const DOMAINES_FRANCE = ["legifrance.gouv.fr"];

export const CATEGORIES_DOMAINES_CONFIANCE: { categorie: CategorieRechercheJuridique; domaines: string[] }[] = [
  { categorie: "benin", domaines: DOMAINES_BENIN },
  { categorie: "ohada", domaines: DOMAINES_OHADA },
  { categorie: "doctrine_droit_compare", domaines: DOMAINES_DOCTRINE_DROIT_COMPARE },
  { categorie: "france", domaines: DOMAINES_FRANCE },
];

// Nombre total de sources (toutes categories ciblees confondues, apres
// deduplication) en-deca duquel un appel Tavily de secours SANS restriction
// de domaine est declenche, pour ne jamais laisser une requete legitime
// sans aucune matiere faute de couverture des domaines de confiance.
// Modifiable via RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM sans redeploiement -
// distincte de JURISPRUDENCE_SEUIL_SOURCES_MINIMUM (module jurisprudence,
// voir services/jurisprudence/domainesConfiance.ts).
export const SEUIL_SOURCES_MINIMUM = Number(process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM ?? 3);
