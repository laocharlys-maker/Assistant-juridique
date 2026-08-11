/**
 * Lot 17 (suite) - 3e mode "Transcrire un document" de Nouvelle action :
 * POST /api/transcription/dossier resout/cree le dossier cible (meme
 * logique que redaction-libre) SANS jamais creer d'Action - le frontend
 * enchaine ensuite avec l'upload existant (POST /api/dossiers/:id/documents,
 * Lot 15), qui declenche l'OCR (Lot 17). Ce test ne couvre que la
 * resolution du dossier et l'absence d'effet de bord (Action) - l'upload et
 * l'OCR eux-memes sont deja couverts par tests/e2e/documents-dossier.test.ts
 * et tests/e2e/ocr.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : « Transcrire un document » (Lot 17, 3e mode Nouvelle action)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;
  let authCookie: string;
  let cabinetId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("transcription-document"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-transcription-document-"));
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

    const { cabinet, user } = await seedCabinetEtTitulaire(prisma, "transcription-document");
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

  it("crée un nouveau dossier quand aucun numéro n'existe déjà, sans jamais créer d'Action", async () => {
    const res = await api("/api/transcription/dossier", {
      method: "POST",
      body: JSON.stringify({
        numero_dossier: "TRANSCRIPTION-E2E-001",
        nom_affaire: "Affaire Transcription E2E",
        nom_client: "Client Fictif Transcription",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dossierId).toBeTruthy();

    const dossier = await prisma.dossier.findUnique({ where: { id: body.dossierId } });
    expect(dossier?.numeroDossier).toBe("TRANSCRIPTION-E2E-001");

    const actions = await prisma.action.findMany({ where: { dossierId: body.dossierId } });
    expect(actions).toHaveLength(0);
  });

  it("réutilise le dossier existant pour le même numéro, comme la rédaction libre", async () => {
    const res = await api("/api/transcription/dossier", {
      method: "POST",
      body: JSON.stringify({
        numero_dossier: "TRANSCRIPTION-E2E-001",
        nom_client: "Client Fictif Transcription",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const dossiers = await prisma.dossier.findMany({ where: { cabinetId, numeroDossier: "TRANSCRIPTION-E2E-001" } });
    expect(dossiers).toHaveLength(1);
    expect(dossiers[0].id).toBe(body.dossierId);
  });

  it("refuse la résolution sans nom de client (seul champ obligatoire)", async () => {
    const res = await api("/api/transcription/dossier", {
      method: "POST",
      body: JSON.stringify({ nom_client: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("le dossier résolu accepte bien un upload de pièce ensuite (chaînage réel avec Lot 15)", async () => {
    const dossierRes = await api("/api/transcription/dossier", {
      method: "POST",
      body: JSON.stringify({ nom_client: "Client Transcription Upload" }),
    });
    const { dossierId } = await dossierRes.json();

    // Type text/plain (jamais eligible OCR, voir services/ocr/detectionScanne.ts)
    // - verifie uniquement le chainage dossier -> upload existant (Lot 15),
    // sans jamais declencher le vrai moteur Tesseract dans ce test (voir
    // tests/e2e/ocr.test.ts pour la justification de cette prudence).
    const contenu = Buffer.from("contenu de test", "utf8");
    const uploadRes = await api(`/api/dossiers/${dossierId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        nom: "note-test.txt",
        fichierDataUrl: `data:text/plain;base64,${contenu.toString("base64")}`,
      }),
    });
    expect(uploadRes.status).toBe(201);
  });
});
