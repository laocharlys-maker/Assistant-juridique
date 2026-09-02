import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Rattrapage au demarrage (idempotence par cabinet) : runRoleSemaineRecapPourTousLesCabinets
 * ne doit RE-tenter un cabinet que si son creneau hebdomadaire courant
 * (vendredi 8h heure du Benin) n'a pas deja ete traite - meme principe que
 * veilleJuridique.rattrapage.test.ts.
 *
 * prisma.roleAudience.findMany renvoie volontairement [] : cela suffit a
 * faire ressortir runRoleSemaineRecapPourCabinet immediatement (aucune
 * audience saisie pour la semaine visee = pas de mail, voir son garde
 * `if (audiences.length === 0) return;`), sans avoir besoin de mocker le
 * mailer - seul le comportement "tente ou pas" est concerne ici.
 */

const prismaMock = vi.hoisted(() => ({
  cabinet: { findMany: vi.fn(), update: vi.fn() },
  roleAudience: { findMany: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

afterEach(() => {
  vi.clearAllMocks();
});

const MAINTENANT = new Date("2026-09-02T10:00:00.000Z"); // mercredi
const CRENEAU_ATTENDU = "2026-08-28T07:00:00.000Z"; // dernier vendredi 7h UTC

describe("runRoleSemaineRecapPourTousLesCabinets - rattrapage idempotent", () => {
  it("tente le cabinet et enregistre le creneau quand jamais execute (null)", async () => {
    const { runRoleSemaineRecapPourTousLesCabinets } = await import("../roleSemaineRecap");
    prismaMock.cabinet.findMany.mockResolvedValue([{ id: "cab-1", roleSemaineDerniereExecution: null }]);
    prismaMock.roleAudience.findMany.mockResolvedValue([]);

    await runRoleSemaineRecapPourTousLesCabinets(MAINTENANT);

    expect(prismaMock.roleAudience.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.cabinet.update).toHaveBeenCalledWith({
      where: { id: "cab-1" },
      data: { roleSemaineDerniereExecution: new Date(CRENEAU_ATTENDU) },
    });
  });

  it("ne tente PAS le cabinet quand le creneau courant est deja enregistre", async () => {
    const { runRoleSemaineRecapPourTousLesCabinets } = await import("../roleSemaineRecap");
    prismaMock.cabinet.findMany.mockResolvedValue([
      { id: "cab-1", roleSemaineDerniereExecution: new Date(CRENEAU_ATTENDU) },
    ]);

    await runRoleSemaineRecapPourTousLesCabinets(MAINTENANT);

    expect(prismaMock.roleAudience.findMany).not.toHaveBeenCalled();
    expect(prismaMock.cabinet.update).not.toHaveBeenCalled();
  });

  it("retente le cabinet quand la derniere execution enregistree precede le creneau courant (rattrapage)", async () => {
    const { runRoleSemaineRecapPourTousLesCabinets } = await import("../roleSemaineRecap");
    prismaMock.cabinet.findMany.mockResolvedValue([
      { id: "cab-1", roleSemaineDerniereExecution: new Date("2026-08-21T07:00:00.000Z") }, // vendredi precedent
    ]);
    prismaMock.roleAudience.findMany.mockResolvedValue([]);

    await runRoleSemaineRecapPourTousLesCabinets(MAINTENANT);

    expect(prismaMock.roleAudience.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.cabinet.update).toHaveBeenCalledWith({
      where: { id: "cab-1" },
      data: { roleSemaineDerniereExecution: new Date(CRENEAU_ATTENDU) },
    });
  });
});
