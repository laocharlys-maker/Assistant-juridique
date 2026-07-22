import { describe, it, expect, vi } from "vitest";
import { splitIntoChunks, summarizeLongText } from "../resumePdf";
import { LlmProvider } from "../llm/types";
import { RESUME_PDF_EXTRAIT_SYSTEM_PROMPT } from "../../prompts/webRedaction";

describe("splitIntoChunks", () => {
  it("renvoie un seul morceau si le texte tient dans la taille demandee", () => {
    const chunks = splitIntoChunks("Un paragraphe court.", 100);
    expect(chunks).toEqual(["Un paragraphe court."]);
  });

  it("decoupe sur les frontieres de paragraphes sans depasser la taille cible", () => {
    const paragraphs = Array.from({ length: 5 }, (_, i) => `Paragraphe ${i}. `.repeat(10));
    const text = paragraphs.join("\n\n");
    const chunks = splitIntoChunks(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // Chaque paragraphe d'origine doit se retrouver entier dans un chunk.
    for (const p of paragraphs) {
      expect(chunks.some((c) => c.includes(p))).toBe(true);
    }
  });

  it("decoupe brutalement un paragraphe unique bien plus grand que la taille cible", () => {
    const hugeParagraph = "x".repeat(5000);
    const chunks = splitIntoChunks(hugeParagraph, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(hugeParagraph);
  });
});

function makeFakeLlm(redactImpl: (system: string, user: string) => Promise<string>): LlmProvider {
  return {
    extractAction: vi.fn(),
    redact: vi.fn(redactImpl),
  };
}

describe("summarizeLongText", () => {
  it("fait un seul appel pour un texte court", async () => {
    const redact = vi.fn().mockResolvedValue("Fiche de synthese finale");
    const llm = makeFakeLlm(redact);

    const result = await summarizeLongText(llm, "Texte court de decision.");

    expect(redact).toHaveBeenCalledTimes(1);
    expect(result).toBe("Fiche de synthese finale");
  });

  it("decoupe et fait un resume par morceau puis une synthese finale pour un texte long", async () => {
    const longText = Array.from({ length: 20 }, (_, i) => `Paragraphe ${i}. `.repeat(300)).join(
      "\n\n"
    );
    const calls: string[] = [];
    const redact = vi.fn(async (system: string) => {
      calls.push(system);
      return system === RESUME_PDF_EXTRAIT_SYSTEM_PROMPT ? "resume partiel" : "fiche finale";
    });
    const llm = makeFakeLlm(redact);

    const result = await summarizeLongText(llm, longText);

    expect(redact.mock.calls.length).toBeGreaterThan(1);
    expect(result).toBe("fiche finale");
  });
});
