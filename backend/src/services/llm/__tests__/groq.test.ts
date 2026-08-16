import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Lot 22 : repli automatique sur le modele de secours (llama-3.1-8b-instant)
 * quand le modele principal (llama-3.3-70b-versatile, voir registreModeles.ts)
 * est refuse par Groq pour une raison caracteristique d'un modele
 * decommissionne - jamais sur une cle invalide (voir registreModeles.test.ts
 * pour la couverture exhaustive de cette distinction ; ici on verifie
 * seulement le branchement reel dans GroqProvider).
 */

let createGroqProvider: typeof import("../groq").createGroqProvider;
const fetchMock = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  process.env.GROQ_API_KEY = "test-key";
  ({ createGroqProvider } = await import("../groq"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function reponseHttp(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function corpsAppel(index: number): { model: string } {
  const [, options] = fetchMock.mock.calls[index]!;
  return JSON.parse((options as { body: string }).body);
}

describe("GroqProvider - repli automatique de modele (Lot22)", () => {
  it("redact : reessaie avec le modele de repli si le principal est decommissionne", async () => {
    fetchMock
      .mockResolvedValueOnce(
        reponseHttp(400, { error: { message: "The model has been decommissioned", code: "model_decommissioned" } })
      )
      .mockResolvedValueOnce(reponseHttp(200, { choices: [{ message: { content: "texte du repli" } }] }));
    const provider = createGroqProvider();

    const resultat = await provider.redact("system", "user");

    expect(resultat).toBe("texte du repli");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(corpsAppel(0).model).toBe("llama-3.3-70b-versatile");
    expect(corpsAppel(1).model).toBe("llama-3.1-8b-instant");
  });

  it("extractAction : reessaie avec le modele de repli si le principal n'existe plus", async () => {
    const sortieValide = {
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
    };
    fetchMock
      .mockResolvedValueOnce(
        reponseHttp(404, { error: { message: "The model `x` does not exist or you do not have access to it." } })
      )
      .mockResolvedValueOnce(reponseHttp(200, { choices: [{ message: { content: JSON.stringify(sortieValide) } }] }));
    const provider = createGroqProvider();

    const resultat = await provider.extractAction("texte source");

    expect(resultat.type_action).toBe("notes");
    expect(corpsAppel(1).model).toBe("llama-3.1-8b-instant");
  });

  it("ne declenche AUCUN repli sur une cle API invalide (401) - l'erreur remonte telle quelle", async () => {
    fetchMock.mockResolvedValueOnce(reponseHttp(401, { error: { message: "invalid api key" } }));
    const provider = createGroqProvider();

    await expect(provider.redact("system", "user")).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
