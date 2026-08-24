import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuthTokenPayload } from "../auth";

/**
 * getAccessibleAvocatIds : un avocat/titulaire ne voyait jusqu'ici QUE ses
 * propres dossiers/evenements - jamais ceux crees par un collaborateur dont
 * il est le responsable (User.responsableId), alors que ce collaborateur,
 * lui, voit deja les dossiers de son responsable (asymetrie constatee en
 * usage reel : un RDV cree par un collaborateur restait invisible dans le
 * calendrier de l'avocat dont il depend). Ce fichier verifie le correctif
 * (avocat/titulaire = lui-meme + ses collaborateurs directs) SANS toucher
 * au comportement cote collaborateur (deja teste implicitement ailleurs,
 * inchange ici).
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  accesSupplementaire: { findMany: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

beforeEach(() => {
  vi.clearAllMocks();
});

function auth(overrides: Partial<AuthTokenPayload> = {}): AuthTokenPayload {
  return { userId: "user-1", cabinetId: "cabinet-1", role: "avocat", ...overrides };
}

describe("getAccessibleAvocatIds", () => {
  it("un avocat voit lui-meme et ses collaborateurs directs (responsableId)", async () => {
    const { getAccessibleAvocatIds } = await import("../access");
    prismaMock.user.findMany.mockResolvedValue([{ id: "collab-1" }, { id: "collab-2" }]);

    const ids = await getAccessibleAvocatIds(auth({ role: "avocat" }));

    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: { cabinetId: "cabinet-1", responsableId: "user-1" },
      select: { id: true },
    });
    expect(ids.sort()).toEqual(["collab-1", "collab-2", "user-1"].sort());
  });

  it("un avocat sans collaborateur ne voit toujours que lui-meme", async () => {
    const { getAccessibleAvocatIds } = await import("../access");
    prismaMock.user.findMany.mockResolvedValue([]);

    const ids = await getAccessibleAvocatIds(auth({ role: "avocat" }));

    expect(ids).toEqual(["user-1"]);
  });

  it("un titulaire voit lui-meme et ses collaborateurs directs, meme mecanisme qu'un avocat", async () => {
    const { getAccessibleAvocatIds } = await import("../access");
    prismaMock.user.findMany.mockResolvedValue([{ id: "collab-9" }]);

    const ids = await getAccessibleAvocatIds(auth({ role: "titulaire" }));

    expect(ids.sort()).toEqual(["collab-9", "user-1"].sort());
  });

  it("comportement collaborateur inchange : lui-meme + son responsable + ses acces supplementaires", async () => {
    const { getAccessibleAvocatIds } = await import("../access");
    prismaMock.user.findUnique.mockResolvedValue({ responsableId: "avocat-resp", accesTousDossiers: false });
    prismaMock.accesSupplementaire.findMany.mockResolvedValue([{ avocatId: "avocat-supp" }]);

    const ids = await getAccessibleAvocatIds(auth({ userId: "collab-1", role: "collaborateur" }));

    expect(ids.sort()).toEqual(["avocat-resp", "avocat-supp", "collab-1"].sort());
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it("comportement collaborateur inchange : acces 'tous les dossiers' renvoie tous les avocats/titulaires du cabinet", async () => {
    const { getAccessibleAvocatIds } = await import("../access");
    prismaMock.user.findUnique.mockResolvedValue({ responsableId: "avocat-resp", accesTousDossiers: true });
    prismaMock.user.findMany.mockResolvedValue([{ id: "avocat-a" }, { id: "avocat-b" }]);

    const ids = await getAccessibleAvocatIds(auth({ userId: "collab-1", role: "collaborateur" }));

    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: { cabinetId: "cabinet-1", role: { in: ["titulaire", "avocat"] } },
      select: { id: true },
    });
    expect(ids.sort()).toEqual(["avocat-a", "avocat-b"].sort());
  });
});
