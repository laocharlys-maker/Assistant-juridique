import { env } from "../../config/env";
import { LlmProvider } from "./types";
import { createGeminiProvider } from "./gemini";
import { createAnthropicProvider } from "./anthropic";

let cachedProvider: LlmProvider | null = null;

export function getLlmProvider(): LlmProvider {
  if (cachedProvider) return cachedProvider;

  cachedProvider =
    env.LLM_PROVIDER === "anthropic" ? createAnthropicProvider() : createGeminiProvider();

  return cachedProvider;
}

export { LlmOutputError } from "./types";
export type { LlmProvider } from "./types";
