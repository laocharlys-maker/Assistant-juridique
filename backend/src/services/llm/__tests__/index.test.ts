import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * services/llm/index.ts route le fournisseur IA a deux niveaux :
 * - getLlmProvider() : lit process.env.LLM_PROVIDER (Groq par defaut en
 *   mode desktop, voir index.ts) - utilise par la plupart des actions.
 * - getAnthropicProviderForced() : force TOUJOURS Anthropic, independamment
 *   de LLM_PROVIDER - utilise par recherche_juridique/jurisprudence/
 *   resume_pdf/veille juridique (decision AzoMedIA du 2026-08-14, voir
 *   routes/webActions.ts ACTIONS_FORCANT_ANTHROPIC et index.ts, cron veille).
 *
 * Chaque fonction met en cache sa propre instance (deux variables de module
 * distinctes) - ce fichier verifie explicitement que l'une n'ecrase jamais
 * le cache de l'autre.
 */

const createGeminiProviderMock = vi.hoisted(() => vi.fn(() => ({ provider: "gemini" })));
const createAnthropicProviderMock = vi.hoisted(() => vi.fn(() => ({ provider: "anthropic" })));
const createGroqProviderMock = vi.hoisted(() => vi.fn(() => ({ provider: "groq" })));

vi.mock("../gemini", () => ({ createGeminiProvider: createGeminiProviderMock }));
vi.mock("../anthropic", () => ({ createAnthropicProvider: createAnthropicProviderMock }));
vi.mock("../groq", () => ({ createGroqProvider: createGroqProviderMock }));

let llmIndex: typeof import("../index");
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.LLM_PROVIDER;
  llmIndex = await import("../index");
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("getLlmProvider", () => {
  it("Groq par défaut quand LLM_PROVIDER vaut 'groq'", () => {
    process.env.LLM_PROVIDER = "groq";
    expect(llmIndex.getLlmProvider()).toEqual({ provider: "groq" });
    expect(createGroqProviderMock).toHaveBeenCalledTimes(1);
  });

  it("Gemini si LLM_PROVIDER absent ou non reconnu (défaut Zod)", () => {
    expect(llmIndex.getLlmProvider()).toEqual({ provider: "gemini" });
    expect(createGeminiProviderMock).toHaveBeenCalledTimes(1);
  });

  it("Anthropic si LLM_PROVIDER='anthropic'", () => {
    process.env.LLM_PROVIDER = "anthropic";
    expect(llmIndex.getLlmProvider()).toEqual({ provider: "anthropic" });
  });

  it("met en cache l'instance : un second appel ne recrée pas le provider", () => {
    process.env.LLM_PROVIDER = "groq";
    llmIndex.getLlmProvider();
    llmIndex.getLlmProvider();
    expect(createGroqProviderMock).toHaveBeenCalledTimes(1);
  });
});

describe("getAnthropicProviderForced", () => {
  it("renvoie toujours Anthropic, même si LLM_PROVIDER='groq'", () => {
    process.env.LLM_PROVIDER = "groq";
    expect(llmIndex.getAnthropicProviderForced()).toEqual({ provider: "anthropic" });
    expect(createAnthropicProviderMock).toHaveBeenCalledTimes(1);
    expect(createGroqProviderMock).not.toHaveBeenCalled();
  });

  it("cache séparé de getLlmProvider() : appeler l'un n'affecte jamais le cache de l'autre", () => {
    process.env.LLM_PROVIDER = "groq";
    llmIndex.getLlmProvider();
    llmIndex.getAnthropicProviderForced();
    llmIndex.getLlmProvider();
    llmIndex.getAnthropicProviderForced();

    expect(createGroqProviderMock).toHaveBeenCalledTimes(1);
    expect(createAnthropicProviderMock).toHaveBeenCalledTimes(1);
  });

  it("propage l'erreur (ex: ANTHROPIC_API_KEY manquant) telle que levée par createAnthropicProvider", () => {
    const erreur = new Error("ANTHROPIC_API_KEY manquant");
    createAnthropicProviderMock.mockImplementationOnce(() => {
      throw erreur;
    });
    expect(() => llmIndex.getAnthropicProviderForced()).toThrow(erreur);
  });
});
