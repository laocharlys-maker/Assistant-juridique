import { z } from "zod";

export const TYPE_ACTION_VALUES = [
  "notes",
  "redac",
  "jurisprudence",
  "recherche_juridique",
  "resume_pdf",
  "conclusions",
  "assignation",
  "mise_en_demeure",
  "traduction",
  "plainte",
  "contrat",
  "notification_date",
  "requete",
] as const;

export const actionOutputSchema = z.object({
  type_action: z.enum(TYPE_ACTION_VALUES),
  categorie_texte: z.string(),
  numero_dossier: z.string().nullable(),
  nom_affaire: z.string().nullable(),
  nom_client: z.string().nullable(),
  date_audience: z.string().nullable(),
  nom_juge: z.string().nullable(),
  decision: z.string().nullable(),
  prochaine_audience: z.string().nullable(),
  pieces_prevoir: z.string().nullable(),
  synthese: z.string().nullable(),
  argumentaire: z.string().nullable(),
});

export type ActionOutput = z.infer<typeof actionOutputSchema>;

// Schema JSON manuel (format OpenAPI/Gemini : "nullable" plutot qu'un type
// tableau, et sans le mot-cle "const" non supporte par l'API Gemini).
export const actionOutputJsonSchema = {
  type: "object",
  properties: {
    type_action: { type: "string", enum: [...TYPE_ACTION_VALUES] },
    categorie_texte: { type: "string" },
    numero_dossier: { type: "string", nullable: true },
    nom_affaire: { type: "string", nullable: true },
    nom_client: { type: "string", nullable: true },
    date_audience: { type: "string", nullable: true },
    nom_juge: { type: "string", nullable: true },
    decision: { type: "string", nullable: true },
    prochaine_audience: { type: "string", nullable: true },
    pieces_prevoir: { type: "string", nullable: true },
    synthese: { type: "string", nullable: true },
    argumentaire: { type: "string", nullable: true },
  },
  required: [
    "type_action",
    "categorie_texte",
    "numero_dossier",
    "nom_affaire",
    "nom_client",
    "date_audience",
    "nom_juge",
    "decision",
    "prochaine_audience",
    "pieces_prevoir",
    "synthese",
    "argumentaire",
  ],
} as const;
