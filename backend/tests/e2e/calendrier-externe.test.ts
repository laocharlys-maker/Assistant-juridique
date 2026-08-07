/**
 * Lot 12b - synchronisation calendrier externe : connexion CalDAV (chiffrement
 * des identifiants au repos), non-blocage de la création d'un Evenement,
 * synchro création/modification/suppression (pas de duplication), résilience
 * réseau (rattrapage au cycle suivant), déconnexion (aucune donnée Aurore
 * affectée).
 *
 * Les adaptateurs Google/CalDAV (appels réseau réels vers des services
 * externes) sont mockés - aucun compte Google ni serveur CalDAV réel n'est
 * disponible dans cet environnement. Le mock intercepte exactement à la
 * frontière `services/calendrierSync/{googleCalendar,caldav}.ts` : tout le
 * reste (routes, hooks, syncQueue.ts, chiffrement Prisma) tourne en
 * conditions réelles contre une vraie base PostgreSQL jetable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

const { caldavMock, googleMock } = vi.hoisted(() => ({
  caldavMock: {
    decouvrirCalendrierPrincipal: vi.fn(),
    caldavAdapter: {
      creerEvenement: vi.fn(),
      modifierEvenement: vi.fn(),
      supprimerEvenement: vi.fn(),
    },
  },
  googleMock: {
    buildGoogleAuthUrl: vi.fn(),
    exchangeCodeForTokens: vi.fn(),
    assurerAccessTokenValide: vi.fn(),
    googleCalendarAdapter: {
      creerEvenement: vi.fn(),
      modifierEvenement: vi.fn(),
      supprimerEvenement: vi.fn(),
    },
  },
}));
vi.mock("../../src/services/calendrierSync/caldav", () => caldavMock);
vi.mock("../../src/services/calendrierSync/googleCalendar", () => googleMock);

describe.skipIf(!pgAvailable)("e2e : synchronisation calendrier externe (Lot 12b)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;
  let runSyncCycle: () => Promise<void>;

  let authCookie: string;
  let userId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("calendrier-externe"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-calendrier-externe-"));
    process.env.APPDATA = fakeAppData;

    process.env.DATABASE_URL = pg.databaseUrl;
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GEMINI_API_KEY = "dummy-test-key";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";
    delete process.env.DATABASE_MODE;
    process.env.LICENCE_BYPASS = "true";

    const { app } = await import("../../src/app");
    const { prisma: prismaClient } = await import("../../src/lib/prisma");
    ({ runSyncCycle } = await import("../../src/services/calendrierSync/syncQueue"));
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user } = await seedCabinetEtTitulaire(prisma, "calendrier-externe");
    userId = user.id;
    authCookie = await mintAuthCookie(user.id, cabinet.id, "titulaire");
    void cabinet;
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    pg?.stop();
    if (fakeAppData) fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  async function api(urlPath: string, options: RequestInit = {}) {
    return fetch(`${baseUrl}${urlPath}`, {
      ...options,
      headers: { "Content-Type": "application/json", Cookie: authCookie, ...(options.headers as Record<string, string>) },
    });
  }

  let connexionId: string;

  it("connecte un agenda CalDAV : les identifiants sont chiffrés au repos", async () => {
    caldavMock.decouvrirCalendrierPrincipal.mockResolvedValue("https://caldav.exemple.test/calendriers/principal/");

    const res = await api("/api/calendrier-externe/caldav", {
      method: "POST",
      body: JSON.stringify({
        caldavUrl: "https://caldav.exemple.test/",
        caldavUsername: "avocat@exemple.test",
        caldavPassword: "mot-de-passe-secret",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    connexionId = body.id;
    // Jamais le mot de passe dans la réponse HTTP.
    expect(JSON.stringify(body)).not.toContain("mot-de-passe-secret");

    const rows = await prisma.$queryRawUnsafe<{ caldav_password: string }[]>(
      `SELECT caldav_password FROM connexions_calendrier_externe WHERE id = $1`,
      connexionId
    );
    expect(rows[0].caldav_password).toMatch(/^enc:v1:/);
    expect(rows[0].caldav_password).not.toContain("mot-de-passe-secret");

    // Mais bien relisible en clair via Prisma (chiffrement transparent).
    const connexion = await prisma.connexionCalendrierExterne.findUnique({ where: { id: connexionId } });
    expect(connexion?.caldavPassword).toBe("mot-de-passe-secret");
  });

  it("le statut ne renvoie jamais le mot de passe", async () => {
    const res = await api("/api/calendrier-externe/statut");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("mot-de-passe-secret");
  });

  let actionEvenementId: string;

  it("la création d'un événement reste rapide : la synchro externe n'est PAS appelée avant le cycle", async () => {
    caldavMock.caldavAdapter.creerEvenement.mockClear();

    const res = await api("/api/evenements", {
      method: "POST",
      body: JSON.stringify({ type: "rdv", titre: "RDV client Koffi", dateDebut: new Date().toISOString() }),
    });
    expect(res.status).toBe(201);
    const evenement = await res.json();
    actionEvenementId = evenement.id;

    // La reponse HTTP est deja revenue : l'adaptateur externe n'a pas encore
    // ete appele (mis en file uniquement, voir syncQueue.ts).
    expect(caldavMock.caldavAdapter.creerEvenement).not.toHaveBeenCalled();

    const sync = await prisma.evenementSyncExterne.findFirst({ where: { evenementId: actionEvenementId } });
    expect(sync?.statut).toBe("en_attente");
  });

  it("le cycle de synchronisation crée bien l'événement côté externe", async () => {
    caldavMock.caldavAdapter.creerEvenement.mockResolvedValue("caldav-uid-1");

    await runSyncCycle();

    expect(caldavMock.caldavAdapter.creerEvenement).toHaveBeenCalledTimes(1);
    const sync = await prisma.evenementSyncExterne.findFirst({ where: { evenementId: actionEvenementId } });
    expect(sync?.statut).toBe("synchronise");
    expect(sync?.externalEventId).toBe("caldav-uid-1");
  });

  it("la modification met à jour l'événement externe (pas de duplication)", async () => {
    const res = await api(`/api/evenements/${actionEvenementId}`, {
      method: "PATCH",
      body: JSON.stringify({ titre: "RDV client Koffi — reporté" }),
    });
    expect(res.status).toBe(200);

    await runSyncCycle();

    expect(caldavMock.caldavAdapter.modifierEvenement).toHaveBeenCalledWith(
      expect.anything(),
      "caldav-uid-1",
      expect.objectContaining({ titre: "RDV client Koffi — reporté" })
    );
    expect(caldavMock.caldavAdapter.creerEvenement).toHaveBeenCalledTimes(1); // toujours 1, pas de doublon
  });

  it("résilience réseau : un échec laisse l'événement intact côté Aurore et repasse la sync au cycle suivant", async () => {
    caldavMock.caldavAdapter.modifierEvenement.mockRejectedValueOnce(new Error("réseau coupé"));

    const res = await api(`/api/evenements/${actionEvenementId}`, {
      method: "PATCH",
      body: JSON.stringify({ titre: "RDV client Koffi — encore reporté" }),
    });
    expect(res.status).toBe(200); // l'operation Aurore reussit malgre l'echec externe a venir

    await runSyncCycle(); // echoue (mock rejette une fois)

    let sync = await prisma.evenementSyncExterne.findFirst({ where: { evenementId: actionEvenementId } });
    expect(sync?.statut).toBe("erreur");
    expect(sync?.tentatives).toBe(1);

    const evenement = await prisma.evenement.findUnique({ where: { id: actionEvenementId } });
    expect(evenement).not.toBeNull();
    expect(evenement?.titre).toBe("RDV client Koffi — encore reporté"); // inchange, jamais affecte

    await runSyncCycle(); // le mock resout normalement cette fois (rattrapage)

    sync = await prisma.evenementSyncExterne.findFirst({ where: { evenementId: actionEvenementId } });
    expect(sync?.statut).toBe("synchronise");
  });

  it("la suppression retire l'événement côté externe puis la ligne de suivi", async () => {
    const res = await api(`/api/evenements/${actionEvenementId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    await runSyncCycle();

    expect(caldavMock.caldavAdapter.supprimerEvenement).toHaveBeenCalledWith(expect.anything(), "caldav-uid-1");
    const sync = await prisma.evenementSyncExterne.findFirst({ where: { connexionId, externalEventId: "caldav-uid-1" } });
    expect(sync).toBeNull();
  });

  it("la déconnexion n'affecte aucune donnée Aurore et arrête la synchro future", async () => {
    // Un nouvel evenement, synchronise avant la deconnexion.
    caldavMock.caldavAdapter.creerEvenement.mockResolvedValue("caldav-uid-2");
    const createRes = await api("/api/evenements", {
      method: "POST",
      body: JSON.stringify({ type: "tache", titre: "Tâche persistante", dateDebut: new Date().toISOString() }),
    });
    const evenement2 = await createRes.json();
    await runSyncCycle();

    const deleteRes = await api(`/api/calendrier-externe/${connexionId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    // La connexion a disparu...
    const connexion = await prisma.connexionCalendrierExterne.findUnique({ where: { id: connexionId } });
    expect(connexion).toBeNull();

    // ...mais l'Evenement Aurore, lui, existe toujours intact.
    const evenementApres = await prisma.evenement.findUnique({ where: { id: evenement2.id } });
    expect(evenementApres).not.toBeNull();
    expect(evenementApres?.titre).toBe("Tâche persistante");

    // Aucune tentative de suppression retroactive cote externe.
    expect(caldavMock.caldavAdapter.supprimerEvenement).not.toHaveBeenCalledWith(expect.anything(), "caldav-uid-2");
  });

  it("un utilisateur sans connexion externe n'enfile aucune synchro (pas d'erreur)", async () => {
    const autre = await prisma.user.create({
      data: {
        cabinetId: (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).cabinetId,
        nom: "Avocat Sans Sync",
        email: "sans-sync-e2e-calendrier-externe@test.invalid",
        motDePasseHash: "x",
        role: "avocat",
      },
    });
    const cookieAutre = await mintAuthCookie(autre.id, autre.cabinetId, "avocat");
    const res = await fetch(`${baseUrl}/api/evenements`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookieAutre },
      body: JSON.stringify({ type: "autre", titre: "Sans agenda connecté", dateDebut: new Date().toISOString() }),
    });
    expect(res.status).toBe(201);
    const evenement = await res.json();
    const sync = await prisma.evenementSyncExterne.findFirst({ where: { evenementId: evenement.id } });
    expect(sync).toBeNull();
  });
});
