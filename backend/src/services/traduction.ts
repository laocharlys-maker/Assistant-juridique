import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { LlmProvider } from "./llm/types";
import { splitIntoChunks } from "./resumePdf";
import {
  TRADUCTION_FR_VERS_EN_SYSTEM_PROMPT,
  TRADUCTION_EN_VERS_FR_SYSTEM_PROMPT,
  buildTraductionUserPrompt,
} from "../prompts/webRedaction";

const CHUNK_SIZE_CHARS = 8000;

export type SensTraduction = "fr_vers_en" | "en_vers_fr";

const SYSTEM_PROMPT_BY_SENS: Record<SensTraduction, string> = {
  fr_vers_en: TRADUCTION_FR_VERS_EN_SYSTEM_PROMPT,
  en_vers_fr: TRADUCTION_EN_VERS_FR_SYSTEM_PROMPT,
};

// Extrait le texte d'un PDF ou d'un .docx fourni en data URL base64, pour
// permettre de traduire un document uploade plutot qu'un texte colle.
export async function extractTextFromDocument(documentDataUrl: string): Promise<string> {
  const matches = documentDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches) {
    throw new Error("Format de document invalide");
  }
  const [, mimeType, base64Data] = matches;
  const buffer = Buffer.from(base64Data, "base64");

  if (mimeType === "application/pdf") {
    const parsed = await pdfParse(buffer);
    return parsed.text.trim();
  }

  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

export async function translateText(
  llm: LlmProvider,
  sens: SensTraduction,
  texte: string
): Promise<string> {
  const systemPrompt = SYSTEM_PROMPT_BY_SENS[sens];
  const texteTrim = texte.trim();

  if (texteTrim.length <= CHUNK_SIZE_CHARS) {
    return llm.redact(systemPrompt, buildTraductionUserPrompt(texteTrim));
  }

  const chunks = splitIntoChunks(texteTrim, CHUNK_SIZE_CHARS);
  const traductions: string[] = [];
  for (const chunk of chunks) {
    traductions.push(await llm.redact(systemPrompt, buildTraductionUserPrompt(chunk)));
  }
  return traductions.join("\n\n");
}
