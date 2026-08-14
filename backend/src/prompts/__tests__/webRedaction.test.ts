import { describe, it, expect } from "vitest";
import { JURISPRUDENCE_SYSTEM_PROMPT } from "../webRedaction";

describe("JURISPRUDENCE_SYSTEM_PROMPT - désambiguïsation du format de citation (régression JURIS-1786731229315)", () => {
  it("ne contient plus la séquence littérale \"[Source N]\" (source de confusion avec le marqueur de sortie [REF: Source N])", () => {
    expect(JURISPRUDENCE_SYSTEM_PROMPT).not.toContain('"[Source N]"');
    expect(JURISPRUDENCE_SYSTEM_PROMPT).not.toContain("[Source N]");
  });

  it("continue d'imposer explicitement le marqueur de sortie [REF: Source N]", () => {
    expect(JURISPRUDENCE_SYSTEM_PROMPT).toContain("[REF: Source N]");
    expect(JURISPRUDENCE_SYSTEM_PROMPT).toContain("FORMAT OBLIGATOIRE DE CITATION");
  });

  it("désigne désormais la liste de sources d'entrée sans reproduire le format de marqueur", () => {
    expect(JURISPRUDENCE_SYSTEM_PROMPT).toContain("liste de sources numerotee");
  });
});
