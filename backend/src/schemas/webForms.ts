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
const texteJuridiqueFields = {
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
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
});

export const miseEnDemeureFormSchema = z.object({
  type_action: z.literal("mise_en_demeure"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
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
]);

export type WebActionForm = z.infer<typeof webActionFormSchema>;
