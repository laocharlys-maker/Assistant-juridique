import { describe, expect, it } from "vitest";
import { anonymize } from "../src/security/anonymizer";
import { deanonymize, OrphanTokenError } from "../src/security/deanonymizer";
import type { TokenMap } from "../src/security/pseudonymisation.types";

function mapDe(entries: [string, string][]): TokenMap {
  return new Map(entries);
}

describe("deanonymize - dé-tokenisation complete", () => {
  it("remplace chaque token par la vraie valeur, aux bons endroits", () => {
    const tokenMap = mapDe([
      ["PARTIE_A", "Jean Dupont"],
      ["PARTIE_B", "Marie Martin"],
      ["JUGE_1", "Paul Kokou"],
    ]);
    const reponseLLM =
      "Attendu que PARTIE_A a assigné PARTIE_B devant le juge PARTIE_A ne s'estime pas... " +
      "Le magistrat JUGE_1 a été saisi.";

    const texteFinal = deanonymize(reponseLLM, tokenMap);

    expect(texteFinal).toContain("Jean Dupont");
    expect(texteFinal).toContain("Marie Martin");
    expect(texteFinal).toContain("Paul Kokou");
    expect(texteFinal).not.toMatch(/PARTIE_[A-Z0-9]+/);
    expect(texteFinal).not.toMatch(/JUGE_[A-Z0-9]+/);
  });

  it("round-trip complet anonymize -> deanonymize restitue le texte original", () => {
    const champs = [
      { champ: "nomClient", role: "PARTIE" as const, valeur: "N'Da Amétépé Kokou" },
      { champ: "nomJuge", role: "JUGE" as const, valeur: "Honorable Sossou" },
    ];
    const original = "Le client N'Da Amétépé Kokou comparaît devant Honorable Sossou. N'Da Amétépé Kokou conteste.";

    const { promptAnonymise, tokenMap } = anonymize(champs, original);
    // Simule une reponse LLM qui a repris fidelement les tokens fournis.
    const texteFinal = deanonymize(promptAnonymise, tokenMap);

    expect(texteFinal).toBe(original);
  });
});

describe("deanonymize - detection de token orphelin", () => {
  it("leve OrphanTokenError si un token non fourni dans la tokenMap apparait (hallucination LLM)", () => {
    const tokenMap = mapDe([["PARTIE_A", "Jean Dupont"]]);
    const reponseLLM = "PARTIE_A a assigné PARTIE_C devant le tribunal.";

    expect(() => deanonymize(reponseLLM, tokenMap)).toThrow(OrphanTokenError);
  });

  it("liste le(s) token(s) orphelin(s) sur l'erreur, jamais la valeur reelle correspondante", () => {
    const tokenMap = mapDe([["PARTIE_A", "Jean Dupont"]]);
    try {
      deanonymize("Texte avec JUGE_1 non fourni", tokenMap);
      expect.unreachable("deanonymize aurait du lever OrphanTokenError");
    } catch (error) {
      expect(error).toBeInstanceOf(OrphanTokenError);
      const orphanError = error as OrphanTokenError;
      expect(orphanError.tokensOrphelins).toContain("JUGE_1");
      expect(orphanError.message).not.toContain("Jean Dupont");
    }
  });

  it("detecte un token dans une casse differente (insensible a la casse) plutot que de le laisser passer", () => {
    const tokenMap = mapDe([["PARTIE_A", "Jean Dupont"]]);
    const reponseLLM = "Le texte mentionne partie_a par erreur de casse.";
    expect(() => deanonymize(reponseLLM, tokenMap)).toThrow(OrphanTokenError);
  });

  it("ne leve rien quand tous les tokens fournis sont correctement remplaces (pas de faux positif)", () => {
    const tokenMap = mapDe([
      ["PARTIE_A", "Jean Dupont"],
      ["PARTIE_B", "Marie Martin"],
    ]);
    const texteFinal = deanonymize("PARTIE_A contre PARTIE_B, affaire ordinaire.", tokenMap);
    expect(texteFinal).toBe("Jean Dupont contre Marie Martin, affaire ordinaire.");
  });
});

describe("deanonymize - collisions de prefixes de tokens", () => {
  it("remplace correctement des tokens dont l'un est un prefixe litteral de l'autre (JUGE_1 / JUGE_10)", () => {
    const tokenMap = mapDe([
      ["JUGE_1", "Premier Juge"],
      ["JUGE_10", "Dixieme Juge"],
    ]);
    const texteFinal = deanonymize("Vu JUGE_10 et JUGE_1 dans le dossier.", tokenMap);
    expect(texteFinal).toBe("Vu Dixieme Juge et Premier Juge dans le dossier.");
    expect(texteFinal).not.toContain("JUGE_");
  });
});
