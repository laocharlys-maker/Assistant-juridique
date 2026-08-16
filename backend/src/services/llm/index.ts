import { LlmProvider } from "./types";
import { createGeminiProvider } from "./gemini";
import { createAnthropicProvider } from "./anthropic";
import { createGroqProvider } from "./groq";

let cachedProvider: LlmProvider | null = null;
let cachedAnthropicProvider: LlmProvider | null = null;

/**
 * Lit process.env.LLM_PROVIDER directement, JAMAIS via l'instance `env` de
 * config/env.ts. Raison (constatee en production, voir index.ts "ORDRE
 * CRITIQUE" et README-LOT7.md section 4.4/4.5) : en mode portable (build
 * desktop), LLM_PROVIDER est positionne par index.ts (defaut "gemini",
 * decision AzoMedIA du 2026-08-14 - remplace l'ancien defaut "groq") avant
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

/**
 * Recherche juridique, recherche/resume de jurisprudence et veille
 * juridique : forcent Anthropic (Claude) quel que soit LLM_PROVIDER,
 * decision AzoMedIA du 2026-08-14 (Groq restait sur ces actions plus
 * gourmandes en tokens - recherches longues, sources multiples - et
 * atteignait regulierement son plafond de tokens/minute sur l'offre
 * gratuite "on_demand"). Toutes les autres actions restent sur
 * getLlmProvider() ci-dessus (Gemini par defaut en mode desktop depuis le
 * 2026-08-14, remplace Groq - meme raisonnement de plafond de
 * tokens/minute sur l'offre gratuite Groq, mais applique cette fois a
 * l'ensemble des types de document). Cache separe de `cachedProvider` : les
 * deux fonctions doivent pouvoir cohabiter sans que l'une n'ecrase le
 * resultat mis en cache de l'autre.
 */
export function getAnthropicProviderForced(): LlmProvider {
  if (cachedAnthropicProvider) return cachedAnthropicProvider;
  cachedAnthropicProvider = createAnthropicProvider();
  return cachedAnthropicProvider;
}

export { LlmOutputError } from "./types";
export type { LlmProvider } from "./types";
