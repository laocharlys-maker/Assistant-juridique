/**
 * Pop-up "Factures en attente de paiement" (tableau de bord) : la liste des
 * rappels ne montre que les factures envoyees et non payees (hors proforma),
 * "Marquer comme payee" reutilise PATCH /api/factures/:id existant, et
 * "Ne plus me rappeler" (POST .../ignorer-rappel) est propre a CHAQUE
 * utilisateur - jamais partage entre les avocats du cabinet.
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

describe.skipIf(!pgAvailable)("e2e : rappels de factures en attente (tableau de bord)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let autreAvocatCookie: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("factures-rappels"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-factures-rappels-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "factures-rappels");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const autreAvocat = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Avocat Deux",
        email: "avocat-deux-e2e-factures-rappels@test.invalid",
        motDePasseHash: "x",
        role: "avocat",
      },
    });
    autreAvocatCookie = await mintAuthCookie(autreAvocat.id, cabinetId, "avocat");
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

  let factureEnvoyeeId: string;

  it("liste uniquement les factures envoyées et non payées (pas les brouillons, pas les proforma)", async () => {
    const brouillon = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Brouillon", numero: "FACT-TEST-001", description: "x", montant: 10000, createdBy: titulaireId, statut: "brouillon" },
    });
    const proforma = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Proforma", numero: "PROF-TEST-001", description: "x", montant: 10000, createdBy: titulaireId, statut: "envoyee", estProforma: true },
    });
    const envoyee = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client En Attente", numero: "FACT-TEST-002", description: "x", montant: 25000, createdBy: titulaireId, statut: "envoyee" },
    });
    factureEnvoyeeId = envoyee.id;

    const res = await api(titulaireCookie, "/api/factures/rappels");
    expect(res.status).toBe(200);
    const factures = await res.json();
    const ids = factures.map((f: { id: string }) => f.id);
    expect(ids).toContain(envoyee.id);
    expect(ids).not.toContain(brouillon.id);
    expect(ids).not.toContain(proforma.id);
  });

  it("« Marquer comme payée » retire la facture de la liste de rappels", async () => {
    const patchRes = await api(titulaireCookie, `/api/factures/${factureEnvoyeeId}`, {
      method: "PATCH",
      body: JSON.stringify({ statut: "payee" }),
    });
    expect(patchRes.status).toBe(200);

    const res = await api(titulaireCookie, "/api/factures/rappels");
    const factures = await res.json();
    expect(factures.map((f: { id: string }) => f.id)).not.toContain(factureEnvoyeeId);
  });

  it("« Ne plus me rappeler » n'affecte que l'utilisateur qui l'a demandé", async () => {
    const facture = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Ignoré", numero: "FACT-TEST-003", description: "x", montant: 15000, createdBy: titulaireId, statut: "envoyee" },
    });

    const ignorerRes = await api(titulaireCookie, `/api/factures/${facture.id}/ignorer-rappel`, { method: "POST" });
    expect(ignorerRes.status).toBe(200);

    const resTitulaire = await api(titulaireCookie, "/api/factures/rappels");
    const facturesTitulaire = await resTitulaire.json();
    expect(facturesTitulaire.map((f: { id: string }) => f.id)).not.toContain(facture.id);

    // L'autre avocat du cabinet voit toujours la facture : le rappel n'est
    // jamais partage entre utilisateurs.
    const resAutre = await api(autreAvocatCookie, "/api/factures/rappels");
    const facturesAutre = await resAutre.json();
    expect(facturesAutre.map((f: { id: string }) => f.id)).toContain(facture.id);
  });
});
