import { describe, it, expect, vi } from "vitest";
import { translateText } from "../traduction";
import { LlmProvider } from "../llm/types";
import { TRADUCTION_FR_VERS_EN_SYSTEM_PROMPT } from "../../prompts/webRedaction";

function makeFakeLlm(redactImpl: (system: string, user: string) => Promise<string>): LlmProvider {
  return {
    extractAction: vi.fn(),
    redact: vi.fn(redactImpl),
  };
}

describe("translateText", () => {
  it("fait un seul appel avec le bon prompt pour un texte court", async () => {
    const redact = vi.fn().mockResolvedValue("Translated text");
    const llm = makeFakeLlm(redact);

    const result = await translateText(llm, "fr_vers_en", "Texte court en français.");

    expect(redact).toHaveBeenCalledTimes(1);
    expect(redact).toHaveBeenCalledWith(TRADUCTION_FR_VERS_EN_SYSTEM_PROMPT, expect.any(String));
    expect(result).toBe("Translated text");
  });

  it("decoupe un texte long et concatene les traductions par morceau", async () => {
    const longText = Array.from({ length: 20 }, (_, i) => `Paragraphe ${i}. `.repeat(300)).join(
      "\n\n"
    );
    let call = 0;
    const redact = vi.fn(async () => `traduction ${call++}`);
    const llm = makeFakeLlm(redact);

    const result = await translateText(llm, "en_vers_fr", longText);

    expect(redact.mock.calls.length).toBeGreaterThan(1);
    expect(result).toContain("traduction 0");
  });
});
