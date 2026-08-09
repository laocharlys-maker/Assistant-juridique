import { describe, it, expect } from "vitest";
import { TypeAction } from "@prisma/client";
import { GABARITS_REDACTION_LIBRE, gabaritPour } from "../gabaritsRedactionLibre";

describe("gabaritsRedactionLibre", () => {
  it("fournit un gabarit non vide pour chacun des 16 types d'action existants", () => {
    const types = Object.values(TypeAction);
    expect(types).toHaveLength(16);
    for (const type of types) {
      const gabarit = gabaritPour(type);
      expect(gabarit).toBeTypeOf("string");
      expect(gabarit.trim().length).toBeGreaterThan(0);
    }
  });

  it("n'a pas d'entree en trop par rapport a l'enum TypeAction", () => {
    const clesGabarits = Object.keys(GABARITS_REDACTION_LIBRE).sort();
    const clesTypeAction = Object.values(TypeAction).sort();
    expect(clesGabarits).toEqual(clesTypeAction);
  });

  // Le titre, l'identite des parties et les formules de mise en page fixes
  // (assignation, conclusions) sont deja produits par le formalisme (voir
  // documentFormalisme.ts) a partir de champsDocument - les repeter dans le
  // gabarit de depart les afficherait deux fois a l'export.
  it("assignation : ne repete pas ce que le formalisme genere deja (DONNÉ ASSIGNATION, identite du defendeur)", () => {
    expect(gabaritPour("assignation")).not.toContain("DONNE ASSIGNATION");
    expect(gabaritPour("assignation")).not.toContain("[identité du défendeur]");
  });

  it("conclusions : ne repete pas ce que le formalisme genere deja (titre, Pour/Contre)", () => {
    expect(gabaritPour("conclusions")).not.toContain("**CONCLUSIONS**");
    expect(gabaritPour("conclusions")).not.toContain("Pour : [demandeur]");
  });
});
