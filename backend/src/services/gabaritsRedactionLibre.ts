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
  // Squelette des 4 sections utilisees par le compte-rendu genere par l'IA
  // (voir routes/webActions.ts, type "notes") - simples titres a completer a
  // la main ici, jamais de contenu pre-redige. Le bloc d'identite
  // (juridiction, greffier, RG...) n'est pas repete ici : il est reconstruit
  // a l'export a partir de Action.champsDocument (voir documentFormalisme.ts),
  // comme pour le mode IA.
  notes:
    "I. RAPPEL DE LA PROCÉDURE\n\n\n\nII. DÉROULEMENT DES DÉBATS ET PLAIDOIRIES\n\n\n\nIII. DÉCISION DU TRIBUNAL\n\n\n\nIV. STRATÉGIE ET SUITE À DONNER\n\n",
  redac: "Pour le compte de [nom du client],\n\n\n\nPar ces motifs, il est demandé à la juridiction de bien vouloir faire droit à la présente plaidoirie.",
  // Le titre "CONCLUSIONS", le bloc "Aff/Objet/A/destinataire", "I. LES
  // PARTIES" (POUR/CONTRE) et la phrase d'ouverture de "II. PLAISE AU
  // TRIBUNAL" sont deja produits par le formalisme (voir
  // documentFormalisme.ts, cas "conclusions") a partir de Action.champsDocument -
  // les repeter ici ferait doublon. Seules les sections de contenu variable
  // restent a completer : expose des faits, discussion juridique, et le
  // dispositif (le formalisme reprend ensuite avec "Sous toutes reserves"/
  // la signature/le bordereau des pieces).
  conclusions:
    "**1. EXPOSÉ DES FAITS ET DE LA PROCÉDURE**\n\n\n\n**2. DISCUSSION JURIDIQUE**\n\n\n\n**III. DISPOSITIF (« Par ces motifs »)**\n\n**PAR CES MOTIFS**\n\n\n\n**En conséquence :**\n\n",
  note_plaidoirie: "**NOTE DE PLAIDOIRIE**\n\n",
  // "DONNÉ ASSIGNATION À :", l'identite du defendeur, le bloc "OÙ ÉTANT ET
  // PARLANT À", la formule de comparution et l'avertissement au defendeur
  // sont deja produits par le formalisme (documentFormalisme.ts, cas
  // "assignation") - les repeter ici ferait doublon. Seules les sections de
  // contenu variable (l'objet, l'expose des faits, la discussion juridique
  // et les demandes) restent a completer.
  assignation:
    "**I. OBJET DE LA DEMANDE**\n\n\n\n**II. EXPOSÉ DES FAITS**\n\n\n\n**III. DISCUSSION JURIDIQUE**\n\n\n\n**EN CONSÉQUENCE**\n\n",
  // La salutation d'ouverture ("Monsieur," / "Madame, Monsieur,") est deja
  // produite par le champ d'identite civilite_appel_destinataire (voir
  // documentFormalisme.ts) - un salut fixe ici en ferait un second, en
  // double. Seule la formule de politesse de cloture reste ici, comme
  // simple suggestion de depart entierement editable/supprimable.
  mise_en_demeure: "\n\nVeuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.",
  plainte:
    "Monsieur le Procureur de la République,\n\n\n\nJe vous prie d'agréer, Monsieur le Procureur, l'expression de ma haute considération.",
  contrat: "**CONTRAT**\n\nEntre les soussignés :\n\n1. [Partie 1]\n2. [Partie 2]\n\nIl a été convenu ce qui suit :\n\n",
  notification_date: "\n\nVeuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.",
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
