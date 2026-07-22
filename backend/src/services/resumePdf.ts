import { LlmProvider } from "./llm/types";
import {
  RESUME_PDF_SYSTEM_PROMPT,
  RESUME_PDF_EXTRAIT_SYSTEM_PROMPT,
  buildResumePdfUserPrompt,
  buildResumePdfExtraitUserPrompt,
} from "../prompts/webRedaction";

// Au-dela de ce seuil, on decoupe le texte plutot que de tout envoyer en un
// seul appel (marge de securite pour rester dans le contexte du modele,
// quel que soit le fournisseur LLM actif).
const MAX_SINGLE_PASS_CHARS = 15000;
const CHUNK_SIZE_CHARS = 8000;

export function splitIntoChunks(text: string, chunkSize: number): string[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > chunkSize && current.length > 0) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    // Un paragraphe a lui seul plus grand que chunkSize : on le decoupe brut.
    while (current.length > chunkSize * 1.5) {
      chunks.push(current.slice(0, chunkSize));
      current = current.slice(chunkSize);
    }
  }
  if (current.trim().length > 0) chunks.push(current);

  return chunks;
}

export async function summarizeLongText(
  llm: LlmProvider,
  texteExtrait: string,
  contexte?: string
): Promise<string> {
  const texte = texteExtrait.trim();

  if (texte.length <= MAX_SINGLE_PASS_CHARS) {
    return llm.redact(
      RESUME_PDF_SYSTEM_PROMPT,
      buildResumePdfUserPrompt({ contexte, texteSource: texte })
    );
  }

  const chunks = splitIntoChunks(texte, CHUNK_SIZE_CHARS);
  const resumesPartiels: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const resume = await llm.redact(
      RESUME_PDF_EXTRAIT_SYSTEM_PROMPT,
      buildResumePdfExtraitUserPrompt({
        partieIndex: i + 1,
        partieTotal: chunks.length,
        extrait: chunks[i],
      })
    );
    resumesPartiels.push(resume);
  }

  const texteCombine = resumesPartiels
    .map((r, i) => `[Partie ${i + 1}/${chunks.length}]\n${r}`)
    .join("\n\n");

  return llm.redact(
    RESUME_PDF_SYSTEM_PROMPT,
    buildResumePdfUserPrompt({ contexte, texteSource: texteCombine })
  );
}
