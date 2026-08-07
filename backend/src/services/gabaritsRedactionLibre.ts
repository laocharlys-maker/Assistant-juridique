import { TypeAction } from "@prisma/client";

/**
 * Lot 11 (Partie B) : referentiel statique (une constante versionnee dans
 * le code, pas une table en base - pas besoin d'admin UI pour cette V1) de
 * la formule d'appel/salutation d'usage par type de document, injectee une
 * seule fois dans Action.contenuGenere a la creation d'un document en mode
 * "redaction libre" (aucun appel LLM). Contenu texte simple, editable comme
 * n'importe quel contenu genere par IA ensuite - PAS une regle de
 * formalisme reconstruite a l'export (voir documentFormalisme.ts, non
 * touche par ce lot). Un type de document sans correspondant de
 * correspondance directe (recherche, resume, traduction...) recoit un
 * gabarit minimal neutre plutot qu'une formule de politesse hors-sujet.
 */
export const GABARITS_REDACTION_LIBRE: Record<TypeAction, string> = {
  notes: "## Compte-rendu d'audience\n\n",
  redac: "Pour le compte de [nom du client],\n\n\n\nPar ces motifs, il est demandé à la juridiction de bien vouloir faire droit à la présente plaidoirie.",
  conclusions:
    "**CONCLUSIONS**\n\nPour : [demandeur]\nContre : [défendeur]\n\n\n\n**PAR CES MOTIFS**\n\nIl est demandé au tribunal de :\n\n",
  note_plaidoirie: "**NOTE DE PLAIDOIRIE**\n\n",
  assignation: "**DONNE ASSIGNATION À :**\n\n[identité du défendeur]\n\n\n\n**PAR CES MOTIFS**\n\n",
  mise_en_demeure:
    "Maître,\n\n\n\nVeuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.",
  plainte:
    "Monsieur le Procureur de la République,\n\n\n\nJe vous prie d'agréer, Monsieur le Procureur, l'expression de ma haute considération.",
  contrat: "**CONTRAT**\n\nEntre les soussignés :\n\n1. [Partie 1]\n2. [Partie 2]\n\nIl a été convenu ce qui suit :\n\n",
  notification_date:
    "Madame, Monsieur,\n\n\n\nVeuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.",
  requete:
    "**REQUÊTE**\n\nÀ Madame/Monsieur le Président,\n\n\n\nC'est pourquoi il est demandé qu'il plaise au tribunal de faire droit à la présente requête.",
  projet_ordonnance: "**PROJET D'ORDONNANCE**\n\nNous, Président du Tribunal...\n\n",
  jurisprudence: "## Recherche de jurisprudence\n\n",
  recherche_juridique: "## Recherche juridique\n\n",
  resume_pdf: "## Résumé\n\n",
  veille_juridique: "## Veille juridique\n\n",
  traduction: "## Traduction\n\n",
};

export function gabaritPour(typeAction: TypeAction): string {
  return GABARITS_REDACTION_LIBRE[typeAction];
}
