import { describe, it, expect } from "vitest";
import { validateExtraction, buildClarificationMessage } from "../validation";
import { ActionOutput } from "../../schemas/action";

function makeAction(overrides: Partial<ActionOutput> = {}): ActionOutput {
  return {
    type_action: "notes",
    categorie_texte: "Compte-rendu d'audience",
    numero_dossier: "12345",
    nom_affaire: "Dupont c/ Martin",
    nom_client: "M. Dupont",
    date_audience: "2026-07-21",
    nom_juge: "Juge X",
    decision: "Renvoi",
    prochaine_audience: "2026-08-21",
    pieces_prevoir: "Pièce A",
    synthese: "Résumé",
    argumentaire: null,
    ...overrides,
  };
}

describe("validateExtraction", () => {
  it("valide une action notes complète", () => {
    const result = validateExtraction(makeAction());
    expect(result.valid).toBe(true);
    expect(result.missingFields).toEqual([]);
  });

  it("rejette une action notes sans numero de dossier", () => {
    const result = validateExtraction(makeAction({ numero_dossier: null }));
    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain("numero_dossier");
  });

  it("rejette une action notes sans date d'audience", () => {
    const result = validateExtraction(makeAction({ date_audience: "" }));
    expect(result.valid).toBe(false);
    expect(result.missingFields).toContain("date_audience");
  });

  it("ne bloque pas une recherche de jurisprudence sans champs de dossier", () => {
    const result = validateExtraction(
      makeAction({
        type_action: "jurisprudence",
        numero_dossier: null,
        nom_affaire: null,
        date_audience: null,
      })
    );
    expect(result.valid).toBe(true);
  });

  it("construit un message de clarification lisible", () => {
    const result = validateExtraction(makeAction({ numero_dossier: null, date_audience: null }));
    const message = buildClarificationMessage(result);
    expect(message).toContain("le numero de dossier");
    expect(message).toContain("la date de l'audience");
  });
});
