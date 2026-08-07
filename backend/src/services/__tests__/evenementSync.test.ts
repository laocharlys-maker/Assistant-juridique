import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    roleAudience: { findUnique: vi.fn() },
    delaiCalcul: { findUnique: vi.fn() },
    evenement: { upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

import {
  syncEvenementDepuisRoleAudience,
  supprimerEvenementDepuisRoleAudience,
  syncEvenementDepuisDelaiCalcul,
  supprimerEvenementDepuisDelaiCalcul,
} from "../evenementSync";

// Lot 12a - contrat de resilience : un hook de synchronisation ne doit
// JAMAIS rejeter, meme si l'appel Prisma sous-jacent echoue (ex: erreur DB
// temporaire) - sinon la creation/suppression du RoleAudience/DelaiCalcul
// d'origine (qui attend ces hooks) echouerait avec lui. Teste ici au niveau
// unitaire (le plus precis pour ce contrat) ; la creation d'origine elle-
// meme est testee en conditions reelles dans tests/e2e/calendrier-unifie.test.ts.
describe("evenementSync - resilience du hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("syncEvenementDepuisRoleAudience ne rejette jamais si prisma.evenement.upsert echoue", async () => {
    prismaMock.roleAudience.findUnique.mockResolvedValue({
      id: "ra1",
      cabinetId: "c1",
      dossierId: null,
      dateAudience: new Date(),
      juridiction: "TPI Cotonou",
      chambre: null,
      parties: "A c/ B",
      objetProcedure: null,
      dernierMotif: null,
      createdBy: "u1",
    });
    prismaMock.evenement.upsert.mockRejectedValue(new Error("DB temporairement indisponible"));

    await expect(syncEvenementDepuisRoleAudience("ra1")).resolves.toBeUndefined();
    expect(prismaMock.evenement.upsert).toHaveBeenCalledTimes(1);
  });

  it("supprimerEvenementDepuisRoleAudience ne rejette jamais si prisma.evenement.deleteMany echoue", async () => {
    prismaMock.evenement.deleteMany.mockRejectedValue(new Error("DB temporairement indisponible"));
    await expect(supprimerEvenementDepuisRoleAudience("ra1")).resolves.toBeUndefined();
  });

  it("syncEvenementDepuisDelaiCalcul ne rejette jamais si prisma.evenement.upsert echoue", async () => {
    prismaMock.delaiCalcul.findUnique.mockResolvedValue({
      id: "dc1",
      dossierId: null,
      dateDepart: new Date(),
      dateLimite: new Date(),
      createdById: "u1",
      delaiType: { nom: "Appel", texteReference: "Art. 1 CPC" },
      createdBy: { cabinetId: "c1" },
    });
    prismaMock.evenement.upsert.mockRejectedValue(new Error("DB temporairement indisponible"));

    await expect(syncEvenementDepuisDelaiCalcul("dc1")).resolves.toBeUndefined();
    expect(prismaMock.evenement.upsert).toHaveBeenCalledTimes(1);
  });

  it("supprimerEvenementDepuisDelaiCalcul ne rejette jamais si prisma.evenement.deleteMany echoue", async () => {
    prismaMock.evenement.deleteMany.mockRejectedValue(new Error("DB temporairement indisponible"));
    await expect(supprimerEvenementDepuisDelaiCalcul("dc1")).resolves.toBeUndefined();
  });

  it("ne fait rien (sans erreur) si le RoleAudience/DelaiCalcul n'existe déjà plus", async () => {
    prismaMock.roleAudience.findUnique.mockResolvedValue(null);
    await expect(syncEvenementDepuisRoleAudience("inexistant")).resolves.toBeUndefined();
    expect(prismaMock.evenement.upsert).not.toHaveBeenCalled();

    prismaMock.delaiCalcul.findUnique.mockResolvedValue(null);
    await expect(syncEvenementDepuisDelaiCalcul("inexistant")).resolves.toBeUndefined();
    expect(prismaMock.evenement.upsert).not.toHaveBeenCalled();
  });
});
