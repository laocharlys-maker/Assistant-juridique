/**
 * Lot 7 - scenario licence expiree -> grace -> blocage (les trois etats
 * definis au Lot 3), verifie via le vrai serveur HTTP plutot qu'en
 * rappelant seulement les fonctions pures deja testees par
 * tests/anonymizer.test.ts et le reste de la suite Lot 3 - complementaire,
 * pas redondant : ce test verifie l'integration bout en bout (activation
 * HTTP -> etat -> effet sur le middleware requireLicence -> acces API).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";
import { signTestLicence } from "./helpers/testLicence";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e licence : valide -> grace -> bloquee", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let authCookie: string;
  let cabinetId: string;
  let empreinteMachine: string;
  let fakeAppData: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("licence-expiry"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-licence-expiry-"));
    process.env.APPDATA = fakeAppData;

    process.env.DATABASE_URL = pg.databaseUrl;
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GEMINI_API_KEY = "dummy-test-key";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";
    process.env.LICENCE_GRACE_JOURS = "14";
    delete process.env.DATABASE_MODE;
    process.env.LICENCE_BYPASS = "false"; // valeur explicite (pas delete) : survit a un rechargement dotenv declenche par l.import de app.ts

    const { app } = await import("../../src/app");
    const { prisma: prismaClient } = await import("../../src/lib/prisma");
    const { getMachineFingerprint } = await import("../../src/security/machineFingerprint");
    prisma = prismaClient;
    empreinteMachine = await getMachineFingerprint();

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user } = await seedCabinetEtTitulaire(prisma, "licence-expiry");
    cabinetId = cabinet.id;
    authCookie = await mintAuthCookie(user.id, cabinet.id);
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    pg?.stop();
    if (fakeAppData) fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  async function activer(dateExpiration: string) {
    const licence = signTestLicence({
      cabinetId,
      nomCabinet: "Cabinet Test",
      dateExpiration,
      empreinteMachine,
      modulesActifs: ["all"],
      modeVerification: "manuel",
    });
    return fetch(`${baseUrl}/api/licence/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(licence) }),
    });
  }

  async function apiDossiers() {
    return fetch(`${baseUrl}/api/dossiers`, { headers: { Cookie: authCookie } });
  }

  it("etat VALIDE : licence non expiree, acces API normal", async () => {
    const res = await activer(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.etat).toBe("valide");

    const dossiers = await apiDossiers();
    expect(dossiers.status).not.toBe(403); // 401 (pas de licence liee a la session) ou 200, jamais 403 licence
  });

  it("etat GRACE : expiree recemment, bandeau attendu mais acces API toujours normal", async () => {
    const res = await activer(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.etat).toBe("grace");
    expect(body.joursRestantsGrace).toBeGreaterThan(0);
    expect(body.joursRestantsGrace).toBeLessThanOrEqual(14);

    const dossiers = await apiDossiers();
    expect(dossiers.status).not.toBe(403);

    const statusRes = await fetch(`${baseUrl}/api/licence/status`);
    const status = await statusRes.json();
    expect(status.etat).toBe("grace");
    expect(status.messageUtilisateur).toMatch(/expiré/i);
  });

  it("etat BLOQUEE : periode de grace depassee, acces API coupe sauf licence/health", async () => {
    const res = await activer(new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.etat).toBe("bloquee");

    const dossiers = await apiDossiers();
    expect(dossiers.status).toBe(403);
    const dossiersBody = await dossiers.json();
    expect(dossiersBody.licenceEtat).toBe("bloquee");

    // Seules /api/licence/* et /health restent accessibles en etat bloque.
    const licenceStatus = await fetch(`${baseUrl}/api/licence/status`);
    expect(licenceStatus.status).toBe(200);
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  it("re-activation avec une licence valide leve le blocage immediatement", async () => {
    const res = await activer(new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.etat).toBe("valide");

    const dossiers = await apiDossiers();
    expect(dossiers.status).not.toBe(403);
  });
});
