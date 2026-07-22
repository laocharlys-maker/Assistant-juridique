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
