import { LlmProvider } from "./types";
import { createGeminiProvider } from "./gemini";
import { createAnthropicProvider } from "./anthropic";
import { createGroqProvider } from "./groq";

let cachedProvider: LlmProvider | null = null;

/**
 * Lit process.env.LLM_PROVIDER directement, JAMAIS via l'instance `env` de
 * config/env.ts. Raison (constatee en production, voir index.ts "ORDRE
 * CRITIQUE" et README-LOT7.md section 4.4/4.5) : en mode portable (build
 * desktop), LLM_PROVIDER est positionne par index.ts (defaut "groq") avant
 * le premier chargement de config/env.ts - mais `env` est un singleton
 * fige au chargement du module (`envSchema.parse(process.env)` execute une
 * seule fois), et l'ordre exact de premiere evaluation des modules dans un
 * bundle Node SEA obfusque + esbuild n'a pas la meme garantie fiable que le
 * code source. Une lecture live de process.env, refaite a CHAQUE appel
 * plutot qu'une fois pour toutes au chargement du module, elimine cette
 * classe de bug par construction plutot que de dependre d'un ordre
 * d'import fragile.
 */
function resolveLlmProvider(): "gemini" | "anthropic" | "groq" {
  const raw = process.env.LLM_PROVIDER;
  return raw === "anthropic" || raw === "groq" ? raw : "gemini";
}

export function getLlmProvider(): LlmProvider {
  if (cachedProvider) return cachedProvider;

  const provider = resolveLlmProvider();
  if (provider === "anthropic") {
    cachedProvider = createAnthropicProvider();
  } else if (provider === "groq") {
    cachedProvider = createGroqProvider();
  } else {
    cachedProvider = createGeminiProvider();
  }

  return cachedProvider;
}

export { LlmOutputError } from "./types";
export type { LlmProvider } from "./types";
