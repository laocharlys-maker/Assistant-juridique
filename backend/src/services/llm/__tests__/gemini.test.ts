import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Lot 22 : repli automatique sur le modele de secours (gemini-2.5-flash)
 * quand le modele principal (gemini-3.6-flash, voir registreModeles.ts) est
 * refuse par Gemini pour une raison caracteristique d'un modele retire -
 * jamais sur une cle invalide (voir registreModeles.test.ts pour la
 * couverture exhaustive de cette distinction ; ici on verifie seulement le
 * branchement reel dans GeminiProvider).
 */

const generateContentMock = vi.hoisted(() => vi.fn());
const getGenerativeModelMock = vi.hoisted(() => vi.fn(() => ({ generateContent: generateContentMock })));

function optionsAppel(index: number): { model: string } {
  return (getGenerativeModelMock.mock.calls[index] as unknown as [{ model: string }])[0];
}

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = getGenerativeModelMock;
  },
}));

let createGeminiProvider: typeof import("../gemini").createGeminiProvider;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = "test-key";
  ({ createGeminiProvider } = await import("../gemini"));
});

function reponseGemini(texte: string) {
  return { response: { text: () => texte } };
}

function erreurModeleIndisponible() {
  return Object.assign(
    new Error(
      "[GoogleGenerativeAI Error]: models/gemini-3.6-flash is not found for API version v1beta, or is not supported for GenerateContent"
    ),
    { status: 404 }
  );
}

describe("GeminiProvider - repli automatique de modele (Lot22)", () => {
  it("redact : reessaie avec le modele de repli si le principal est indisponible", async () => {
    generateContentMock.mockRejectedValueOnce(erreurModeleIndisponible());
    generateContentMock.mockResolvedValueOnce(reponseGemini("texte du repli"));
    const provider = createGeminiProvider();

    const resultat = await provider.redact("system", "user");

    expect(resultat).toBe("texte du repli");
    expect(getGenerativeModelMock).toHaveBeenCalledTimes(2);
    expect(optionsAppel(0)).toMatchObject({ model: "gemini-3.6-flash" });
    expect(optionsAppel(1)).toMatchObject({ model: "gemini-2.5-flash" });
  });

  it("extractAction : reessaie avec le modele de repli si le principal est indisponible", async () => {
    const sortieValide = JSON.stringify({
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
    });
    generateContentMock.mockRejectedValueOnce(erreurModeleIndisponible());
    generateContentMock.mockResolvedValueOnce(reponseGemini(sortieValide));
    const provider = createGeminiProvider();

    const resultat = await provider.extractAction("texte source");

    expect(resultat.type_action).toBe("notes");
    expect(optionsAppel(1)).toMatchObject({ model: "gemini-2.5-flash" });
  });

  it("ne declenche AUCUN repli sur une cle API invalide (401) - l'erreur remonte telle quelle", async () => {
    const erreurCleInvalide = Object.assign(new Error("[GoogleGenerativeAI Error]: API key not valid"), { status: 401 });
    generateContentMock.mockRejectedValueOnce(erreurCleInvalide);
    const provider = createGeminiProvider();

    await expect(provider.redact("system", "user")).rejects.toThrow(erreurCleInvalide);
    expect(getGenerativeModelMock).toHaveBeenCalledTimes(1);
  });
});
