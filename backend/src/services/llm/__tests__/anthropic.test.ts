import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * services/llm/anthropic.ts, methode redact() - regression JURIS-1786731229315 :
 * verifie (1) que max_tokens transmis a l'API reflete bien options.maxTokens
 * quand fourni (utilise par routes/webActions.ts pour la jurisprudence,
 * MAX_TOKENS_JURISPRUDENCE), et (2) que stop_reason/usage.output_tokens sont
 * desormais loggues pour CHAQUE appel redact(), pour diagnostiquer une
 * future troncature avec preuve directe plutot que par deduction.
 */

const createMock = vi.hoisted(() => vi.fn());
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

let createAnthropicProvider: typeof import("../anthropic").createAnthropicProvider;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = "test-key";
  ({ createAnthropicProvider } = await import("../anthropic"));
});

function reponseAnthropic(overrides: Partial<{ stop_reason: string; output_tokens: number; input_tokens: number; texte: string }> = {}) {
  return {
    content: [{ type: "text", text: overrides.texte ?? "Texte généré." }],
    stop_reason: overrides.stop_reason ?? "end_turn",
    usage: { output_tokens: overrides.output_tokens ?? 42, input_tokens: overrides.input_tokens ?? 100 },
  };
}

describe("AnthropicProvider.redact - max_tokens", () => {
  it("utilise 8192 par défaut quand aucun maxTokens n'est fourni (comportement des autres types de document, inchangé)", async () => {
    createMock.mockResolvedValue(reponseAnthropic());
    const provider = createAnthropicProvider();

    await provider.redact("system", "user");

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 8192 }));
  });

  it("utilise le maxTokens explicite quand fourni (ex: MAX_TOKENS_JURISPRUDENCE=16000)", async () => {
    createMock.mockResolvedValue(reponseAnthropic());
    const provider = createAnthropicProvider();

    await provider.redact("system", "user", { maxTokens: 16000 });

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 16000 }));
  });
});

describe("AnthropicProvider.redact - log stop_reason/usage (régression JURIS-1786731229315)", () => {
  it("logge stop_reason et usage.output_tokens pour un appel normal (end_turn)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    createMock.mockResolvedValue(reponseAnthropic({ stop_reason: "end_turn", output_tokens: 1500 }));
    const provider = createAnthropicProvider();

    await provider.redact("system", "user");

    const appelPertinent = logSpy.mock.calls.find((call) => String(call[0]).includes("llm-anthropic"));
    expect(appelPertinent).toBeDefined();
    expect(String(appelPertinent![0])).toContain("stop_reason=end_turn");
    expect(String(appelPertinent![0])).toContain("output_tokens=1500");
    logSpy.mockRestore();
  });

  it("logge stop_reason=max_tokens quand la réponse est tronquée par la limite de sortie", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    createMock.mockResolvedValue(reponseAnthropic({ stop_reason: "max_tokens", output_tokens: 8192 }));
    const provider = createAnthropicProvider();

    await provider.redact("system", "user");

    const appelPertinent = logSpy.mock.calls.find((call) => String(call[0]).includes("llm-anthropic"));
    expect(String(appelPertinent![0])).toContain("stop_reason=max_tokens");
    expect(String(appelPertinent![0])).toContain("output_tokens=8192");
    logSpy.mockRestore();
  });
});
