import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Rattrapage au demarrage (idempotence par cabinet) : runVeillePourTousLesCabinets
 * ne doit RE-tenter un cabinet que si son creneau hebdomadaire courant
 * (lundi 7h heure du Benin) n'a pas deja ete traite - jamais deux fois pour
 * le meme creneau, meme si l'app redemarre plusieurs fois la meme semaine.
 *
 * prisma.cabinet.findUnique (appele en interne par runVeilleForCabinet,
 * meme fichier) renvoie volontairement veilleActive=false : cela suffit a
 * faire ressortir runVeilleForCabinet immediatement (voir son garde
 * `!cabinet.veilleActive` en tete de fonction), sans avoir besoin de mocker
 * Tavily/LLM - seul le comportement "tente ou pas" de
 * runVeillePourTousLesCabinets est concerne par ce fichier, pas le contenu
 * genere (deja couvert ailleurs).
 */

const prismaMock = vi.hoisted(() => ({
  cabinet: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  user: { findFirst: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

afterEach(() => {
  vi.clearAllMocks();
});

const MAINTENANT = new Date("2026-09-02T10:00:00.000Z"); // mercredi
const CRENEAU_ATTENDU = "2026-08-31T06:00:00.000Z"; // dernier lundi 6h UTC

describe("runVeillePourTousLesCabinets - rattrapage idempotent", () => {
  it("tente le cabinet et enregistre le creneau quand jamais execute (null)", async () => {
    const { runVeillePourTousLesCabinets } = await import("../veilleJuridique");
    prismaMock.cabinet.findMany.mockResolvedValue([{ id: "cab-1", veilleDerniereExecution: null }]);
    prismaMock.cabinet.findUnique.mockResolvedValue({
      actif: true,
      veilleActive: false,
      veilleSujets: null,
      modulesDesactives: [],
    });

    await runVeillePourTousLesCabinets({ redact: vi.fn(), extractAction: vi.fn() }, MAINTENANT);

    expect(prismaMock.cabinet.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.cabinet.update).toHaveBeenCalledWith({
      where: { id: "cab-1" },
      data: { veilleDerniereExecution: new Date(CRENEAU_ATTENDU) },
    });
  });

  it("ne tente PAS le cabinet quand le creneau courant est deja enregistre", async () => {
    const { runVeillePourTousLesCabinets } = await import("../veilleJuridique");
    prismaMock.cabinet.findMany.mockResolvedValue([
      { id: "cab-1", veilleDerniereExecution: new Date(CRENEAU_ATTENDU) },
    ]);

    await runVeillePourTousLesCabinets({ redact: vi.fn(), extractAction: vi.fn() }, MAINTENANT);

    expect(prismaMock.cabinet.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.cabinet.update).not.toHaveBeenCalled();
  });

  it("retente le cabinet quand la derniere execution enregistree precede le creneau courant (rattrapage)", async () => {
    const { runVeillePourTousLesCabinets } = await import("../veilleJuridique");
    prismaMock.cabinet.findMany.mockResolvedValue([
      { id: "cab-1", veilleDerniereExecution: new Date("2026-08-24T06:00:00.000Z") }, // lundi precedent
    ]);
    prismaMock.cabinet.findUnique.mockResolvedValue({
      actif: true,
      veilleActive: false,
      veilleSujets: null,
      modulesDesactives: [],
    });

    await runVeillePourTousLesCabinets({ redact: vi.fn(), extractAction: vi.fn() }, MAINTENANT);

    expect(prismaMock.cabinet.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.cabinet.update).toHaveBeenCalledWith({
      where: { id: "cab-1" },
      data: { veilleDerniereExecution: new Date(CRENEAU_ATTENDU) },
    });
  });
});
