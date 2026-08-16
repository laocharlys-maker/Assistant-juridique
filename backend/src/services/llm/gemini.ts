import { GoogleGenerativeAI } from "@google/generative-ai";
import { actionOutputSchema, actionOutputJsonSchema, ActionOutput } from "../../schemas/action";
import { LEGAL_ASSISTANT_SYSTEM_PROMPT, buildUserPrompt } from "../../prompts/legalAssistant";
import { LlmProvider, LlmOutputError } from "./types";
import { withTransientRetry } from "../../lib/retry";
import { MissingConfigurationError } from "../../lib/configurationError";
import { appelerAvecRepli } from "./registreModeles";

export class GeminiProvider implements LlmProvider {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async extractAction(rawInput: string): Promise<ActionOutput> {
    const text = await appelerAvecRepli("gemini", async (nomModele) => {
      const model = this.client.getGenerativeModel({
        model: nomModele,
        systemInstruction: LEGAL_ASSISTANT_SYSTEM_PROMPT,
        generationConfig: {
          responseMimeType: "application/json",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          responseSchema: actionOutputJsonSchema as any,
        },
      });

      const result = await withTransientRetry(() => model.generateContent(buildUserPrompt(rawInput)));
      return result.response.text();
    });

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

  async redact(systemPrompt: string, userPrompt: string, options?: { maxTokens?: number }): Promise<string> {
    return appelerAvecRepli("gemini", async (nomModele) => {
      const model = this.client.getGenerativeModel({
        model: nomModele,
        systemInstruction: systemPrompt,
        // Explicite plutot que de compter sur le defaut du modele. Gemini
        // gere desormais tous les types de document SAUF recherche
        // juridique/jurisprudence/resume PDF/veille juridique (sur Anthropic,
        // voir services/llm/index.ts, getAnthropicProviderForced) - ce
        // defaut de 8192 n'a donc plus a absorber les fiches de jurisprudence
        // longues (jusqu'a 3000 mots), qui ne passent plus par ce chemin.
        generationConfig: { maxOutputTokens: options?.maxTokens ?? 8192 },
      });

      const result = await withTransientRetry(() => model.generateContent(userPrompt));
      return result.response.text();
    });
  }
}

export function createGeminiProvider(): GeminiProvider {
  // process.env directement, pas env.GEMINI_API_KEY (config/env.ts) - voir
  // services/llm/index.ts, resolveLlmProvider() pour le detail.
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new MissingConfigurationError("GEMINI_API_KEY manquant");
  }
  return new GeminiProvider(apiKey);
}
