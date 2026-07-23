import { z } from "zod";

export const notesFormSchema = z.object({
  type_action: z.literal("notes"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1),
  nom_juge: z.string().optional(),
  decision: z.string().min(1),
  prochaine_audience: z.string().optional(),
  pieces_prevoir: z.array(z.string()).optional(),
});

// Champs communs a plaidoirie / conclusions / assignation : meme logique
// (dossier + contexte + axes d'argumentation), seul le texte genere differe.
// nom_client est optionnel : necessaire seulement si le dossier n'existe pas
// encore (creation a la volee), ignore si le dossier existe deja.
const texteJuridiqueFields = {
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1).optional(),
  contexte: z.string().min(1),
  axes_argumentation: z.array(z.string().min(1)).min(1),
};

export const redacFormSchema = z.object({
  type_action: z.literal("redac"),
  ...texteJuridiqueFields,
});

export const conclusionsFormSchema = z.object({
  type_action: z.literal("conclusions"),
  ...texteJuridiqueFields,
});

export const assignationFormSchema = z.object({
  type_action: z.literal("assignation"),
  ...texteJuridiqueFields,
  // Le defendeur assigne - distinct du client, sert d'adresse sur l'acte.
  destinataire: z.string().min(1),
  // Avocat en charge du dossier - affiche sur l'acte, jamais devine.
  nom_avocat: z.string().min(1),
  // Huissier/commissaire de justice charge de la delivrance de l'acte.
  nom_huissier: z.string().min(1),
  // Juridiction saisie (ex: Tribunal Judiciaire de Cotonou) - jamais devinee.
  nom_juridiction: z.string().min(1),
  // Chambre au sein de la juridiction (ex: chambre administrative) - pas
  // toujours connue au moment de la redaction.
  nom_chambre: z.string().optional(),
  // Demandes precises au tribunal ("PAR CES MOTIFS") - jamais devinees par
  // l'IA, toujours saisies par l'avocat.
  demandes: z.array(z.string().min(1)).min(1),
  // Pieces versees aux debats (bordereau) - optionnel, peut etre complete plus tard.
  pieces: z.array(z.string().min(1)).optional(),
});

export const miseEnDemeureFormSchema = z.object({
  type_action: z.literal("mise_en_demeure"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1).optional(),
  destinataire: z.string().min(1),
  contexte: z.string().min(1),
  delai_jours: z.coerce.number().int().positive(),
});

export const jurisprudenceFormSchema = z.object({
  type_action: z.literal("jurisprudence"),
  theme: z.string().min(1),
  juridictions: z.array(z.string()).optional(),
});

export const rechercheJuridiqueFormSchema = z.object({
  type_action: z.literal("recherche_juridique"),
  question: z.string().min(1),
});

export const resumePdfFormSchema = z.object({
  type_action: z.literal("resume_pdf"),
  // Data URL base64 "data:application/pdf;base64,...."
  pdfDataUrl: z.string().regex(/^data:application\/pdf;base64,/),
  contexte: z.string().optional(),
});

export const traductionFormSchema = z.object({
  type_action: z.literal("traduction"),
  sens: z.enum(["fr_vers_en", "en_vers_fr"]),
  texte_source: z.string().optional(),
  // Data URL base64 d'un PDF ou d'un .docx, alternative au texte colle.
  documentDataUrl: z
    .string()
    .regex(
      /^data:(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document);base64,/
    )
    .optional(),
});

export const plainteFormSchema = z.object({
  type_action: z.literal("plainte"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1).optional(),
  // Personne visee par la plainte - distincte du destinataire du courrier.
  nom_defendeur: z.string().min(1),
  // Autorite destinataire (ex: Procureur de la Republique pres le Tribunal de...).
  destinataire: z.string().min(1),
  nom_juridiction: z.string().min(1),
  nom_chambre: z.string().optional(),
  nom_avocat: z.string().min(1),
  motifs: z.string().min(1),
  demandes: z.array(z.string().min(1)).min(1),
  preuves: z.array(z.string().min(1)).optional(),
});

export const contratFormSchema = z.object({
  type_action: z.literal("contrat"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1).optional(),
  est_avenant: z.boolean().optional(),
  // Champs d'un contrat "normal" - non requis si avenant.
  type_contrat: z.string().optional(),
  partie_1: z.string().optional(),
  partie_2: z.string().optional(),
  objet: z.string().optional(),
  obligations: z.string().optional(),
  duree: z.string().optional(),
  remuneration: z.string().optional(),
  date_effet: z.string().optional(),
  conditions_resiliation: z.string().optional(),
  clauses_particulieres: z.array(z.string().min(1)).optional(),
  // Champs specifiques a un avenant.
  reference_contrat_initial: z.string().optional(),
  objet_avenant: z.string().optional(),
});

export const notificationDateFormSchema = z.object({
  type_action: z.literal("notification_date"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1).optional(),
  destinataire: z.string().min(1),
  objet: z.string().min(1),
  date_notifiee: z.string().min(1),
  lieu: z.string().optional(),
  nom_juridiction: z.string().optional(),
  precisions: z.string().optional(),
});

export const requeteFormSchema = z.object({
  type_action: z.literal("requete"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1).optional(),
  destinataire: z.string().min(1),
  nom_juridiction: z.string().min(1),
  objet: z.string().min(1),
  motifs: z.string().min(1),
});

export const webActionFormSchema = z.discriminatedUnion("type_action", [
  notesFormSchema,
  redacFormSchema,
  conclusionsFormSchema,
  assignationFormSchema,
  miseEnDemeureFormSchema,
  jurisprudenceFormSchema,
  rechercheJuridiqueFormSchema,
  resumePdfFormSchema,
  traductionFormSchema,
  plainteFormSchema,
  contratFormSchema,
  notificationDateFormSchema,
  requeteFormSchema,
]);

export type WebActionForm = z.infer<typeof webActionFormSchema>;
