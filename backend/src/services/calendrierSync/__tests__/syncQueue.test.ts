import { describe, it, expect, vi, beforeEach } from "vitest";

const { prismaMock, googleAdapterMock, caldavAdapterMock } = vi.hoisted(() => ({
  prismaMock: {
    evenement: { findUnique: vi.fn() },
    connexionCalendrierExterne: { findMany: vi.fn() },
    evenementSyncExterne: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
  googleAdapterMock: { creerEvenement: vi.fn(), modifierEvenement: vi.fn(), supprimerEvenement: vi.fn() },
  caldavAdapterMock: { creerEvenement: vi.fn(), modifierEvenement: vi.fn(), supprimerEvenement: vi.fn() },
}));
vi.mock("../../../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../googleCalendar", () => ({ googleCalendarAdapter: googleAdapterMock }));
vi.mock("../caldav", () => ({ caldavAdapter: caldavAdapterMock }));

import { enqueuerSyncEvenement, enqueuerSuppressionEvenement, runSyncCycle } from "../syncQueue";

describe("syncQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Defauts "vides" pour toutes les ecritures Prisma - chaque test ne
    // surcharge (mockResolvedValueOnce) que ce qui lui importe vraiment.
    prismaMock.evenementSyncExterne.findMany.mockResolvedValue([]);
    prismaMock.evenementSyncExterne.update.mockResolvedValue({});
    prismaMock.evenementSyncExterne.delete.mockResolvedValue({});
    prismaMock.evenementSyncExterne.upsert.mockResolvedValue({});
    prismaMock.evenementSyncExterne.updateMany.mockResolvedValue({ count: 0 });
  });

  describe("enqueuerSyncEvenement", () => {
    it("crée une ligne EvenementSyncExterne pour chaque connexion active du créateur et des assignés", async () => {
      prismaMock.evenement.findUnique.mockResolvedValue({
        id: "evt1",
        createdById: "u1",
        assignes: [{ userId: "u2" }],
      });
      prismaMock.connexionCalendrierExterne.findMany.mockResolvedValue([{ id: "conn1" }, { id: "conn2" }]);

      await enqueuerSyncEvenement("evt1");

      expect(prismaMock.connexionCalendrierExterne.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: { in: ["u1", "u2"] }, actif: true } })
      );
      expect(prismaMock.evenementSyncExterne.upsert).toHaveBeenCalledTimes(2);
    });

    it("ne fait rien si aucune connexion active", async () => {
      prismaMock.evenement.findUnique.mockResolvedValue({ id: "evt1", createdById: "u1", assignes: [] });
      prismaMock.connexionCalendrierExterne.findMany.mockResolvedValue([]);

      await enqueuerSyncEvenement("evt1");
      expect(prismaMock.evenementSyncExterne.upsert).not.toHaveBeenCalled();
    });

    it("ne rejette jamais, même si prisma échoue (hook additif)", async () => {
      prismaMock.evenement.findUnique.mockRejectedValue(new Error("DB down"));
      await expect(enqueuerSyncEvenement("evt1")).resolves.toBeUndefined();
    });
  });

  describe("enqueuerSuppressionEvenement", () => {
    it("marque les syncs existantes en 'a_supprimer'", async () => {
      await enqueuerSuppressionEvenement("evt1");
      expect(prismaMock.evenementSyncExterne.updateMany).toHaveBeenCalledWith({
        where: { evenementId: "evt1" },
        data: { statut: "a_supprimer", tentatives: 0, derniereErreur: null },
      });
    });

    it("ne rejette jamais, même si prisma échoue", async () => {
      prismaMock.evenementSyncExterne.updateMany.mockRejectedValueOnce(new Error("DB down"));
      await expect(enqueuerSuppressionEvenement("evt1")).resolves.toBeUndefined();
    });
  });

  describe("runSyncCycle", () => {
    it("crée l'événement externe pour une sync 'en_attente' sans externalEventId, puis marque 'synchronise'", async () => {
      prismaMock.evenementSyncExterne.findMany
        .mockResolvedValueOnce([]) // a_supprimer
        .mockResolvedValueOnce([
          {
            id: "sync1",
            evenementId: "evt1",
            connexionId: "conn1",
            externalEventId: null,
            tentatives: 0,
            connexion: { id: "conn1", provider: "google" },
            evenement: { titre: "RDV", description: null, lieu: null, dateDebut: new Date(), dateFin: null, touteLaJournee: false },
          },
        ]);
      googleAdapterMock.creerEvenement.mockResolvedValue("google-evt-1");

      await runSyncCycle();

      expect(googleAdapterMock.creerEvenement).toHaveBeenCalledTimes(1);
      expect(prismaMock.evenementSyncExterne.update).toHaveBeenCalledWith({
        where: { id: "sync1" },
        data: { statut: "synchronise", externalEventId: "google-evt-1", tentatives: 0, derniereErreur: null },
      });
    });

    it("modifie (pas de duplication) quand externalEventId existe déjà", async () => {
      prismaMock.evenementSyncExterne.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: "sync1",
          evenementId: "evt1",
          connexionId: "conn1",
          externalEventId: "google-evt-1",
          tentatives: 0,
          connexion: { id: "conn1", provider: "google" },
          evenement: { titre: "RDV modifié", description: null, lieu: null, dateDebut: new Date(), dateFin: null, touteLaJournee: false },
        },
      ]);

      await runSyncCycle();

      expect(googleAdapterMock.modifierEvenement).toHaveBeenCalledWith(expect.anything(), "google-evt-1", expect.anything());
      expect(googleAdapterMock.creerEvenement).not.toHaveBeenCalled();
    });

    it("résilience réseau : un échec incrémente les tentatives et repasse en 'erreur', sans jamais planter le cycle", async () => {
      prismaMock.evenementSyncExterne.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: "sync1",
          evenementId: "evt1",
          connexionId: "conn1",
          externalEventId: null,
          tentatives: 1,
          connexion: { id: "conn1", provider: "google" },
          evenement: { titre: "RDV", description: null, lieu: null, dateDebut: new Date(), dateFin: null, touteLaJournee: false },
        },
      ]);
      googleAdapterMock.creerEvenement.mockRejectedValue(new Error("réseau coupé"));

      await expect(runSyncCycle()).resolves.toBeUndefined();

      expect(prismaMock.evenementSyncExterne.update).toHaveBeenCalledWith({
        where: { id: "sync1" },
        data: { statut: "erreur", tentatives: 2, derniereErreur: "réseau coupé" },
      });
    });

    it("supprime côté externe puis retire la ligne de suivi pour un statut 'a_supprimer'", async () => {
      prismaMock.evenementSyncExterne.findMany.mockResolvedValueOnce([
        {
          id: "sync1",
          connexionId: "conn1",
          externalEventId: "google-evt-1",
          tentatives: 0,
          connexion: { id: "conn1", provider: "google" },
        },
      ]);
      googleAdapterMock.supprimerEvenement.mockResolvedValue(undefined);

      await runSyncCycle();

      expect(googleAdapterMock.supprimerEvenement).toHaveBeenCalledWith(expect.anything(), "google-evt-1");
      expect(prismaMock.evenementSyncExterne.delete).toHaveBeenCalledWith({ where: { id: "sync1" } });
    });

    it("abandonne (et nettoie la ligne) après le nombre maximal de tentatives de suppression", async () => {
      prismaMock.evenementSyncExterne.findMany.mockResolvedValueOnce([
        {
          id: "sync1",
          connexionId: "conn1",
          externalEventId: "google-evt-1",
          tentatives: 4, // -> 5eme tentative = seuil MAX_TENTATIVES
          connexion: { id: "conn1", provider: "google" },
        },
      ]);
      googleAdapterMock.supprimerEvenement.mockRejectedValue(new Error("indisponible"));

      await runSyncCycle();

      expect(prismaMock.evenementSyncExterne.delete).toHaveBeenCalledWith({ where: { id: "sync1" } });
      expect(prismaMock.evenementSyncExterne.update).not.toHaveBeenCalled();
    });

    it("utilise l'adaptateur CalDAV pour une connexion provider=caldav", async () => {
      prismaMock.evenementSyncExterne.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          id: "sync1",
          evenementId: "evt1",
          connexionId: "conn1",
          externalEventId: null,
          tentatives: 0,
          connexion: { id: "conn1", provider: "caldav" },
          evenement: { titre: "RDV", description: null, lieu: null, dateDebut: new Date(), dateFin: null, touteLaJournee: false },
        },
      ]);
      caldavAdapterMock.creerEvenement.mockResolvedValue("aurore-uid-1");

      await runSyncCycle();

      expect(caldavAdapterMock.creerEvenement).toHaveBeenCalledTimes(1);
      expect(googleAdapterMock.creerEvenement).not.toHaveBeenCalled();
    });
  });
});
