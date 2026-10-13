/**
 * Module RH Cabinet, RH-2 - suivi de stage : creation (titulaire
 * uniquement, responsable avec compte Aurore obligatoire), prolongation
 * (reinitialise les rappels), cloture, et rappels d'echeance idempotents
 * (J-30/J-15/J-7/J-0) via runRappelsStage.
 *
 * Tourne sur une base PostgreSQL de test jetable (voir full-workflow.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : module RH Cabinet - suivi de stage (RH-2)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let avocatCookie: string;
  let avocatId: string;
  let ficheId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("stages"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-stages-"));
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
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "stages");
    cabinetId = cabinet.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const avocat = await prisma.user.create({
      data: { cabinetId, nom: "Avocat Responsable", email: "responsable-e2e-stages@test.invalid", motDePasseHash: "x", role: "avocat" },
    });
    avocatId = avocat.id;
    avocatCookie = await mintAuthCookie(avocat.id, cabinetId, "avocat");

    const ficheRes = await fetch(`${baseUrl}/api/personnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: titulaireCookie },
      body: JSON.stringify({ nom: "Sossou", prenoms: "Bertin", categorie: "stagiaire", typeContrat: "stage", dateEntree: "2026-09-01" }),
    });
    ficheId = (await ficheRes.json()).id;
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  function api(cookie: string, path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
    });
  }

  let stageId: string;

  it("le titulaire peut creer un stage avec un responsable ayant un compte Aurore", async () => {
    const res = await api(titulaireCookie, `/api/personnel/${ficheId}/stages`, {
      method: "POST",
      body: JSON.stringify({ responsableId: avocatId, dateDebut: "2026-09-01", dateFinPrevue: "2027-02-28", objet: "Stage de fin d'études" }),
    });
    expect(res.status).toBe(201);
    const stage = await res.json();
    expect(stage.statut).toBe("en_cours");
    expect(stage.responsable.id).toBe(avocatId);
    stageId = stage.id;
  });

  it("un avocat ne peut pas creer de stage (reserve au titulaire)", async () => {
    const res = await api(avocatCookie, `/api/personnel/${ficheId}/stages`, {
      method: "POST",
      body: JSON.stringify({ responsableId: avocatId, dateDebut: "2026-09-01", dateFinPrevue: "2027-02-28" }),
    });
    expect(res.status).toBe(403);
  });

  it("creer un stage avec un responsable inexistant echoue (404)", async () => {
    const res = await api(titulaireCookie, `/api/personnel/${ficheId}/stages`, {
      method: "POST",
      body: JSON.stringify({ responsableId: "00000000-0000-0000-0000-000000000000", dateDebut: "2026-09-01", dateFinPrevue: "2027-02-28" }),
    });
    expect(res.status).toBe(404);
  });

  it("runRappelsStage envoie les rappels en retard en une seule fois (rattrapage) et jamais deux fois (idempotence)", async () => {
    // Echeance deja largement depassee pour forcer tous les paliers +
    // l'alerte repetee en un seul passage (simule une app restee fermee
    // longtemps).
    await prisma.stage.update({ where: { id: stageId }, data: { dateFinPrevue: new Date(Date.now() - 40 * 86400000) } });

    const { runRappelsStage } = await import("../../src/jobs/stageRappels");
    await runRappelsStage();

    const notifsApres1erPassage = await prisma.notification.count({ where: { type: "stage_echeance", destinataireId: avocatId } });
    // j30, j15, j7, j0 + l'alerte du jour = 5 notifications en un seul rattrapage.
    expect(notifsApres1erPassage).toBe(5);

    await runRappelsStage();
    const notifsApres2ePassage = await prisma.notification.count({ where: { type: "stage_echeance", destinataireId: avocatId } });
    expect(notifsApres2ePassage).toBe(5);
  });

  it("prolonger le stage cree un historique et reinitialise les rappels futurs", async () => {
    const res = await api(avocatCookie, `/api/stages/${stageId}/prolonger`, {
      method: "POST",
      body: JSON.stringify({ nouvelleDateFin: "2027-05-31", motif: "besoin supplémentaire de l'équipe" }),
    });
    expect(res.status).toBe(200);
    const stage = await res.json();
    expect(stage.prolongations.length).toBe(1);
    expect(stage.statut).toBe("en_cours");

    const rappelsRestants = await prisma.stageRappelEnvoye.count({ where: { stageId } });
    expect(rappelsRestants).toBe(0);
  });

  it("le responsable peut cloturer le stage", async () => {
    const res = await api(avocatCookie, `/api/stages/${stageId}/statut`, {
      method: "PATCH",
      body: JSON.stringify({ statut: "termine" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).statut).toBe("termine");

    // Un stage termine ne doit plus jamais recevoir de rappel.
    const { runRappelsStage } = await import("../../src/jobs/stageRappels");
    const avant = await prisma.notification.count({ where: { type: "stage_echeance" } });
    await runRappelsStage();
    const apres = await prisma.notification.count({ where: { type: "stage_echeance" } });
    expect(apres).toBe(avant);
  });
});
