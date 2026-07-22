import { describe, it, expect } from "vitest";
import { splitSujets, periodeLabel } from "../veilleJuridiqueUtils";

describe("splitSujets", () => {
  it("separe les sujets par virgule", () => {
    expect(splitSujets("droit du travail, baux commerciaux, OHADA")).toEqual([
      "droit du travail",
      "baux commerciaux",
      "OHADA",
    ]);
  });

  it("separe les sujets par saut de ligne", () => {
    expect(splitSujets("droit du travail\nbaux commerciaux\n\nOHADA")).toEqual([
      "droit du travail",
      "baux commerciaux",
      "OHADA",
    ]);
  });

  it("ignore les entrees vides et les espaces superflus", () => {
    expect(splitSujets("  droit du travail ,, , OHADA  ")).toEqual(["droit du travail", "OHADA"]);
  });

  it("renvoie un tableau vide pour une chaine vide", () => {
    expect(splitSujets("")).toEqual([]);
  });
});

describe("periodeLabel", () => {
  it("couvre les 7 jours precedant la date donnee", () => {
    const now = new Date("2026-07-22T10:00:00Z");
    expect(periodeLabel(now)).toBe("15/07/2026 au 22/07/2026");
  });
});
