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
});
