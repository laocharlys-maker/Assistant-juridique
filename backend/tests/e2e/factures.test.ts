/**
 * GET /api/factures : les factures payées sont déclassées sous les
 * factures non encore payées (brouillon/envoyée), pour que le titulaire
 * voie toujours en premier ce qui reste à encaisser.
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

describe.skipIf(!pgAvailable)("e2e : GET /api/factures - tri factures payées/non payées", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let titulaireId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("factures"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-factures-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "factures");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    pg?.stop();
    if (fakeAppData) fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  async function api(cookie: string, urlPath: string, options: RequestInit = {}) {
    return fetch(`${baseUrl}${urlPath}`, {
      ...options,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(options.headers as Record<string, string>) },
    });
  }

  it("les factures payées apparaissent après les factures non payées, quelle que soit leur date de création", async () => {
    // Creee en premier (donc la plus ancienne) mais deja payee : doit quand
    // meme se retrouver derriere les factures non payees, plus recentes.
    const payeeAncienne = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Payé", numero: "FACT-TEST-101", description: "x", montant: 10000, createdBy: titulaireId, statut: "payee" },
    });
    const brouillonRecent = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Brouillon", numero: "FACT-TEST-102", description: "x", montant: 20000, createdBy: titulaireId, statut: "brouillon" },
    });
    const envoyeeRecente = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Envoyée", numero: "FACT-TEST-103", description: "x", montant: 30000, createdBy: titulaireId, statut: "envoyee" },
    });

    const res = await api(titulaireCookie, "/api/factures");
    expect(res.status).toBe(200);
    const factures = await res.json();
    const ids = factures.map((f: { id: string }) => f.id);

    const indexPayee = ids.indexOf(payeeAncienne.id);
    const indexBrouillon = ids.indexOf(brouillonRecent.id);
    const indexEnvoyee = ids.indexOf(envoyeeRecente.id);

    expect(indexPayee).toBeGreaterThan(indexBrouillon);
    expect(indexPayee).toBeGreaterThan(indexEnvoyee);
    // A l'interieur du groupe "non payees", l'ordre par date de creation
    // (le plus recent en premier) reste inchange : la plus recente en tete.
    expect(indexEnvoyee).toBeLessThan(indexBrouillon);
  });
});
