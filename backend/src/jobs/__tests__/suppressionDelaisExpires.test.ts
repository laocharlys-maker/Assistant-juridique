import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Suppression automatique des delais dont la date limite est depassee de
 * plus de 3 jours (demande explicite : rubrique "Délais") - meme mecanisme
 * que la route manuelle DELETE /api/delais/:id (routes/delais.ts) : supprime
 * le DelaiCalcul PUIS nettoie l'Evenement calendrier lie via
 * supprimerEvenementDepuisDelaiCalcul.
 */

const prismaMock = vi.hoisted(() => ({
  delaiCalcul: { findMany: vi.fn(), deleteMany: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

const supprimerEvenementMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/evenementSync", () => ({ supprimerEvenementDepuisDelaiCalcul: supprimerEvenementMock }));

let runSuppressionDelaisExpires: typeof import("../suppressionDelaisExpires").runSuppressionDelaisExpires;

beforeEach(async () => {
  vi.clearAllMocks();
  supprimerEvenementMock.mockResolvedValue(undefined);
  ({ runSuppressionDelaisExpires } = await import("../suppressionDelaisExpires"));
});

describe("runSuppressionDelaisExpires", () => {
  it("ne supprime rien s'il n'y a aucun délai dépassé de plus de 3 jours", async () => {
    prismaMock.delaiCalcul.findMany.mockResolvedValue([]);

    const count = await runSuppressionDelaisExpires();

    expect(count).toBe(0);
    expect(prismaMock.delaiCalcul.deleteMany).not.toHaveBeenCalled();
    expect(supprimerEvenementMock).not.toHaveBeenCalled();
  });

  it("interroge avec un seuil de 3 jours dans le passé (dateLimite < now - 3j)", async () => {
    prismaMock.delaiCalcul.findMany.mockResolvedValue([]);
    const avant = Date.now();

    await runSuppressionDelaisExpires();

    const [{ where }] = prismaMock.delaiCalcul.findMany.mock.calls[0]!;
    const seuilMs = where.dateLimite.lt.getTime();
    const ecartJours = (avant - seuilMs) / (24 * 60 * 60 * 1000);
    expect(ecartJours).toBeGreaterThanOrEqual(2.99);
    expect(ecartJours).toBeLessThanOrEqual(3.01);
  });

  it("supprime les délais expirés trouvés et nettoie leur événement calendrier lié", async () => {
    prismaMock.delaiCalcul.findMany.mockResolvedValue([
      { id: "delai-1", dateLimite: new Date("2026-08-01") },
      { id: "delai-2", dateLimite: new Date("2026-08-02") },
    ]);

    const count = await runSuppressionDelaisExpires();

    expect(count).toBe(2);
    expect(prismaMock.delaiCalcul.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["delai-1", "delai-2"] } } });
    expect(supprimerEvenementMock).toHaveBeenCalledWith("delai-1");
    expect(supprimerEvenementMock).toHaveBeenCalledWith("delai-2");
  });

  it("continue de traiter les autres délais même si le nettoyage de l'événement échoue pour l'un d'eux", async () => {
    prismaMock.delaiCalcul.findMany.mockResolvedValue([
      { id: "delai-1", dateLimite: new Date("2026-08-01") },
      { id: "delai-2", dateLimite: new Date("2026-08-02") },
    ]);
    supprimerEvenementMock.mockRejectedValueOnce(new Error("échec simulé")).mockResolvedValueOnce(undefined);

    const count = await runSuppressionDelaisExpires();

    expect(count).toBe(2);
    expect(supprimerEvenementMock).toHaveBeenCalledTimes(2);
  });
});
