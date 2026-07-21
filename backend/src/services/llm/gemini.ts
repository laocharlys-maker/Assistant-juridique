import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../../config/env";
import { actionOutputSchema, actionOutputJsonSchema, ActionOutput } from "../../schemas/action";
import { LEGAL_ASSISTANT_SYSTEM_PROMPT, buildUserPrompt } from "../../prompts/legalAssistant";
import { LlmProvider, LlmOutputError } from "./types";
import { withTransientRetry } from "../../lib/retry";

export class GeminiProvider implements LlmProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async extractAction(rawInput: string): Promise<ActionOutput> {
    const model = this.client.getGenerativeModel({
      model: "gemini-2.0-flash-001",
      systemInstruction: LEGAL_ASSISTANT_SYSTEM_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        responseSchema: actionOutputJsonSchema as any,
      },
    });

    const result = await withTransientRetry(() => model.generateContent(buildUserPrompt(rawInput)));
    const text = result.response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmOutputError("Gemini n'a pas retourne un JSON valide", text);
    }

    const validated = actionOutputSchema.safeParse(parsed);
    if (!validated.success) {
      throw new LlmOutputError(
        `Sortie Gemini non conforme au schema : ${validated.error.message}`,
        text
      );
    }

    return validated.data;
  }
}

export function createGeminiProvider(): GeminiProvider {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY manquant");
  }
  return new GeminiProvider(env.GEMINI_API_KEY);
}
