import { env } from "../../config/env";
import { LlmProvider } from "./types";
import { createGeminiProvider } from "./gemini";
import { createAnthropicProvider } from "./anthropic";
import { createGroqProvider } from "./groq";

let cachedProvider: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (cachedProvider) return cachedProvider;

  if (env.LLM_PROVIDER === "anthropic") {
    cachedProvider = createAnthropicProvider();
  } else if (env.LLM_PROVIDER === "groq") {
    cachedProvider = createGroqProvider();
  } else {
    cachedProvider = createGeminiProvider();
  }

  return cachedProvider;
}

export { LlmOutputError } from "./types";
export type { LlmProvider } from "./types";
