/**
 * Lot 11 (Partie B) - mode de création "rédaction libre" : aucun formulaire
 * à champs obligatoires, aucun appel LLM, contenuGenere initialisé avec le
 * gabarit statique du type de document choisi. Vérifie aussi l'articulation
 * avec la Partie A (le document créé passe par le même cycle verrou/version).
 *
 * Tourne sur une base PostgreSQL de test jetable (voir full-workflow.test.ts).
 * Licence non testee ici (LICENCE_BYPASS), deja couverte ailleurs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

// Sentinelle : si le chemin de redaction libre appelait par erreur le LLM,
// ce mock le detecterait immediatement (callCount > 0).
const { llmMock } = vi.hoisted(() => ({ llmMock: { callCount: 0 } }));
vi.mock("../../src/services/llm", () => ({
  getLlmProvider: () => ({
    redact: async () => {
      llmMock.callCount++;
      return "ne devrait jamais etre appele";
    },
    extractAction: vi.fn(),
  }),
  LlmOutputError: class LlmOutputError extends Error {},
}));

describe.skipIf(!pgAvailable)("e2e : mode rédaction libre (Lot 11, Partie B)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;
  let authCookie: string;
  let cabinetId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("redaction-libre"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-redaction-libre-"));
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

    const { cabinet, user } = await seedCabinetEtTitulaire(prisma, "redaction-libre");
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

  async function api(urlPath: string, options: RequestInit = {}) {
    return fetch(`${baseUrl}${urlPath}`, {
      ...options,
      headers: { "Content-Type": "application/json", Cookie: authCookie, ...(options.headers as Record<string, string>) },
    });
  }

  it("crée un dossier et une Action en mode rédaction libre, sans champ métier obligatoire", async () => {
    const res = await api("/api/actions/redaction-libre", {
      method: "POST",
      body: JSON.stringify({
        type_action: "mise_en_demeure",
        numero_dossier: "LIBRE-E2E-001",
        nom_affaire: "Affaire Rédaction Libre E2E",
        nom_client: "Client Fictif Libre",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.actionId).toBeTruthy();
    expect(body.dossierId).toBeTruthy();
    expect(body.contenuGenere).toContain("Maître");

    const action = await prisma.action.findUnique({ where: { id: body.actionId } });
    expect(action?.modeCreation).toBe("redaction_libre");
    expect(action?.statut).toBe("en_attente_validation");
    expect(action?.champsDocument).toBeNull();
    expect(action?.contenuGenere).toBe(body.contenuGenere);
  });

  it("refuse la création sans nom de client (seul champ obligatoire)", async () => {
    const res = await api("/api/actions/redaction-libre", {
      method: "POST",
      body: JSON.stringify({ type_action: "mise_en_demeure", nom_client: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("refuse un type de document qui n'existe pas parmi les 16 types", async () => {
    const res = await api("/api/actions/redaction-libre", {
      method: "POST",
      body: JSON.stringify({ type_action: "type_invalide", nom_client: "Client Fictif Libre" }),
    });
    expect(res.status).toBe(400);
  });

  it("ne déclenche aucun appel LLM ni pseudonymisation", async () => {
    llmMock.callCount = 0;
    const res = await api("/api/actions/redaction-libre", {
      method: "POST",
      body: JSON.stringify({ type_action: "plainte", nom_client: "Client Sans IA" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(llmMock.callCount).toBe(0);
    const action = await prisma.action.findUnique({ where: { id: body.actionId } });
    expect(action?.donneesPseudonymisees).toBe(false);
  });

  it("réutilise un dossier existant par numéro, comme le mode IA", async () => {
    const res = await api("/api/actions/redaction-libre", {
      method: "POST",
      body: JSON.stringify({
        type_action: "notification_date",
        numero_dossier: "LIBRE-E2E-001",
        nom_client: "Client Fictif Libre",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const dossiers = await prisma.dossier.findMany({ where: { cabinetId, numeroDossier: "LIBRE-E2E-001" } });
    expect(dossiers).toHaveLength(1);
    expect(dossiers[0].id).toBe(body.dossierId);
  });

  it("exporte sans erreur en Word et en PDF un document en mode rédaction libre", async () => {
    const createRes = await api("/api/actions/redaction-libre", {
      method: "POST",
      body: JSON.stringify({ type_action: "requete", nom_client: "Client Export Libre" }),
    });
    const { actionId } = await createRes.json();

    const wordRes = await api(`/api/actions/${actionId}/word`);
    expect(wordRes.status).toBe(200);
    const wordBuffer = Buffer.from(await wordRes.arrayBuffer());
    expect(wordBuffer.subarray(0, 2).toString()).toBe("PK");

    const pdfRes = await api(`/api/actions/${actionId}/pdf`);
    expect(pdfRes.status).toBe(200);
    const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
    expect(pdfBuffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("s'intègre au cycle verrou/version de la Partie A comme un document généré par IA", async () => {
    const createRes = await api("/api/actions/redaction-libre", {
      method: "POST",
      body: JSON.stringify({ type_action: "contrat", nom_client: "Client Cycle Combiné" }),
    });
    const { actionId } = await createRes.json();

    const verrouRes = await api(`/api/actions/${actionId}/verrou`, { method: "POST" });
    expect(verrouRes.status).toBe(200);

    const versionRes = await api(`/api/actions/${actionId}/versions`, {
      method: "POST",
      body: JSON.stringify({ contenu: "Contrat édité manuellement." }),
    });
    expect(versionRes.status).toBe(201);
    const version = await versionRes.json();

    const validerRes = await api(`/api/actions/${actionId}/versions/${version.id}/valider`, { method: "POST" });
    expect(validerRes.status).toBe(200);

    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.contenuGenere).toBe("Contrat édité manuellement.");
    expect(action?.statut).toBe("valide");
  });
});
