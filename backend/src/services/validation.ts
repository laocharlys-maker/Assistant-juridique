import { ActionOutput } from "../schemas/action";

export interface ValidationResult {
  valid: boolean;
  missingFields: (keyof ActionOutput)[];
}

const REQUIRED_FIELDS_BY_TYPE: Record<ActionOutput["type_action"], (keyof ActionOutput)[]> = {
  notes: ["numero_dossier", "nom_affaire", "date_audience"],
  redac: ["nom_affaire"],
  jurisprudence: [],
  recherche_juridique: [],
  resume_pdf: [],
  conclusions: ["nom_affaire"],
  assignation: ["nom_affaire"],
  mise_en_demeure: ["nom_affaire"],
};

const FIELD_LABELS: Partial<Record<keyof ActionOutput, string>> = {
  numero_dossier: "le numero de dossier",
  nom_affaire: "le nom de l'affaire",
  date_audience: "la date de l'audience",
};

function isMissing(value: string | null): boolean {
  return value === null || value.trim().length === 0;
}

export function validateExtraction(action: ActionOutput): ValidationResult {
  const requiredFields = REQUIRED_FIELDS_BY_TYPE[action.type_action];
  const missingFields = requiredFields.filter((field) => isMissing(action[field] as string | null));

  return { valid: missingFields.length === 0, missingFields };
}

export function buildClarificationMessage(result: ValidationResult): string {
  const labels = result.missingFields.map((field) => FIELD_LABELS[field] ?? field);
  return `Il me manque des informations pour continuer : ${labels.join(", ")}. Peux-tu me les preciser ?`;
}
