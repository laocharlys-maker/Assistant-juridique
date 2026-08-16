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

/**
 * Lot 22 : repli automatique sur le modele de secours quand le modele
 * principal ("claude-sonnet-5", voir registreModeles.ts) est refuse par
 * Anthropic pour une raison caracteristique d'un modele retire/renomme -
 * jamais sur une cle invalide/quota epuise (voir registreModeles.test.ts
 * pour la couverture exhaustive de cette distinction ; ici on verifie
 * seulement le branchement reel dans AnthropicProvider).
 */
describe("AnthropicProvider - repli automatique de modele (Lot22)", () => {
  function erreurModeleIndisponible() {
    return Object.assign(new Error('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-sonnet-5 not_found"}}'), {
      status: 404,
    });
  }

  function toolUseValide() {
    return {
      content: [
        {
          type: "tool_use",
          input: {
            type_action: "notes",
            categorie_texte: "Note",
            numero_dossier: null,
            nom_affaire: null,
            nom_client: null,
            date_audience: null,
            nom_juridiction: null,
            nom_chambre: null,
            decision: null,
            prochaine_audience: null,
            pieces_prevoir: null,
            synthese: null,
            argumentaire: null,
          },
        },
      ],
    };
  }

  it("extractAction : reessaie avec le modele de repli si le principal est indisponible, sans erreur pour l'appelant", async () => {
    createMock.mockRejectedValueOnce(erreurModeleIndisponible());
    createMock.mockResolvedValueOnce(toolUseValide());
    const provider = createAnthropicProvider();

    const resultat = await provider.extractAction("texte source");

    expect(resultat.type_action).toBe("notes");
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: "claude-sonnet-5" });
    expect(createMock.mock.calls[1]![0]).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  });

  it("redact : reessaie avec le modele de repli si le principal est indisponible", async () => {
    createMock.mockRejectedValueOnce(erreurModeleIndisponible());
    createMock.mockResolvedValueOnce(reponseAnthropic({ texte: "Texte redige par le modele de repli." }));
    const provider = createAnthropicProvider();

    const resultat = await provider.redact("system", "user");

    expect(resultat).toBe("Texte redige par le modele de repli.");
    expect(createMock.mock.calls[0]![0]).toMatchObject({ model: "claude-sonnet-5" });
    expect(createMock.mock.calls[1]![0]).toMatchObject({ model: "claude-haiku-4-5-20251001" });
  });

  it("ne declenche AUCUN repli sur une cle API invalide (401) - l'erreur remonte telle quelle", async () => {
    const erreurCleInvalide = Object.assign(new Error("401 authentication_error: invalid x-api-key"), { status: 401 });
    createMock.mockRejectedValueOnce(erreurCleInvalide);
    const provider = createAnthropicProvider();

    await expect(provider.redact("system", "user")).rejects.toThrow(erreurCleInvalide);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("ne declenche AUCUN repli sur un quota epuise (429) - l'erreur remonte telle quelle", async () => {
    const erreurQuota = Object.assign(new Error("429 rate_limit_exceeded"), { status: 429 });
    createMock.mockRejectedValueOnce(erreurQuota);
    const provider = createAnthropicProvider();

    await expect(provider.redact("system", "user")).rejects.toThrow(erreurQuota);
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
