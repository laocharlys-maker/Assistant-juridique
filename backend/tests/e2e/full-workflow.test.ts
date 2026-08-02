/**
 * Lot 7 - scenario complet : demarrage app -> activation licence -> login
 * -> creation client -> generation d'un acte (avec pseudonymisation,
 * Lot 5) -> export Word/PDF -> verification du chiffrement au repos
 * (Lot 2bis). Tourne sur une base PostgreSQL de test jetable (jamais une
 * base contenant de vraies donnees), avec un LLM mocke (aucun appel
 * facture) et un jeu de donnees fictif clairement identifiable ("Cabinet
 * Test", "Client Fictif" - voir helpers/testApp.ts).
 *
 * Se saute automatiquement (avec un message clair) si aucun PostgreSQL
 * n'est trouve sur la machine - voir helpers/testPostgres.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie, CLIENT_FICTIF_NOM } from "./helpers/testApp";
import { signTestLicence } from "./helpers/testLicence";

const pgAvailable = findPostgresBinDir() !== null;

const { llmMock } = vi.hoisted(() => ({
  llmMock: {
    redactImpl: async (_system: string, _user: string) => "reponse par defaut",
    callCount: 0,
    lastUserPrompt: "",
  },
}));

vi.mock("../../src/services/llm", () => ({
  getLlmProvider: () => ({
    redact: async (systemPrompt: string, userPrompt: string) => {
      llmMock.callCount++;
      llmMock.lastUserPrompt = userPrompt;
      return llmMock.redactImpl(systemPrompt, userPrompt);
    },
    extractAction: vi.fn(),
  }),
  LlmOutputError: class LlmOutputError extends Error {},
}));

describe.skipIf(!pgAvailable)("e2e complet : demarrage -> licence -> login -> client -> acte -> export -> chiffrement", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let authCookie: string;
  let cabinetId: string;
  let clientId: string;
  let actionId: string;
  let fakeAppData: string;
  const NOM_REEL_DESTINATAIRE = "Jean Kokou Dupont-N'Da";

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("full-workflow"))!;

    // Isole entierement ce test du vrai profil utilisateur - la cle de
    // chiffrement, le fichier de licence et l'empreinte machine mise en
    // cache ne doivent jamais atterrir dans le vrai %APPDATA%/Aurore.
    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-full-workflow-"));
    process.env.APPDATA = fakeAppData;

    process.env.DATABASE_URL = pg.databaseUrl;
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GEMINI_API_KEY = "dummy-test-key";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";
    delete process.env.DATABASE_MODE; // "externe" : pas de bootstrap Postgres portable (deja fourni ci-dessus)
    delete process.env.LICENCE_BYPASS; // licence testee pour de vrai, pas contournee

    const { app } = await import("../../src/app");
    const { prisma: prismaClient } = await import("../../src/lib/prisma");
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user } = await seedCabinetEtTitulaire(prisma, "full-workflow");
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

  async function api(path: string, options: RequestInit = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", Cookie: authCookie, ...(options.headers as Record<string, string>) },
    });
    return res;
  }

  it("demarre et repond au health-check", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.database).toBe("connected");
  });

  it("bloque l'acces API sans licence active", async () => {
    const res = await api("/api/dossiers");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.licenceEtat).toBe("absente");
  });

  it("active une licence de test valide (signee avec la cle de test du Lot 3)", async () => {
    const { getMachineFingerprint } = await import("../../src/security/machineFingerprint");
    const empreinteMachine = await getMachineFingerprint();

    const licence = signTestLicence({
      cabinetId,
      nomCabinet: "Cabinet Test",
      dateExpiration: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      empreinteMachine,
      modulesActifs: ["all"],
      modeVerification: "manuel",
    });

    const res = await fetch(`${baseUrl}/api/licence/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(licence) }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.etat).toBe("valide");
  });

  it("permet l'acces API une fois la licence active (login/session)", async () => {
    const res = await api("/api/auth/me");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("titulaire");
  });

  it("cree un client fictif", async () => {
    const res = await api("/api/clients", {
      method: "POST",
      body: JSON.stringify({
        nom: CLIENT_FICTIF_NOM,
        telephone: "+229 90 00 00 00",
        numeroPieceIdentite: "CNI-E2E-000111",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.nom).toBe(CLIENT_FICTIF_NOM);
    clientId = body.id;
  });

  it("chiffre le client au repos (Lot 2bis) - illisible en base brute", async () => {
    const rows = await prisma.$queryRawUnsafe<{ nom: string; telephone: string }[]>(
      `SELECT nom, telephone FROM clients WHERE id = $1`,
      clientId
    );
    expect(rows[0].nom).toMatch(/^enc:v1:/);
    expect(rows[0].nom).not.toContain(CLIENT_FICTIF_NOM);
    expect(rows[0].telephone).toMatch(/^enc:v1:/);
  });

  it("genere un acte avec pseudonymisation : le LLM mocke ne recoit jamais le vrai nom", async () => {
    llmMock.redactImpl = async () =>
      "En conséquence, la présente vaut mise en demeure adressée à PARTIE_A d'exécuter ses obligations.";
    llmMock.callCount = 0;

    const res = await api("/api/actions/web", {
      method: "POST",
      body: JSON.stringify({
        type_action: "mise_en_demeure",
        numero_dossier: "MED-E2E-001",
        nom_affaire: "Affaire E2E",
        nom_client: CLIENT_FICTIF_NOM,
        destinataire: NOM_REEL_DESTINATAIRE,
        contexte: "Le destinataire n'a pas execute son obligation contractuelle malgre plusieurs relances.",
        delai_jours: 8,
        consequences: ["saisir la juridiction competente"],
        mode_notification: "lrar",
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    actionId = body.actionId;

    expect(llmMock.callCount).toBe(1);
    expect(llmMock.lastUserPrompt).not.toContain(NOM_REEL_DESTINATAIRE);
    expect(llmMock.lastUserPrompt).toContain("PARTIE_A");

    expect(body.contenu).toContain(NOM_REEL_DESTINATAIRE);
    expect(body.contenu).not.toContain("PARTIE_A");
  });

  it("marque l'action generee comme pseudonymisee et chiffre son contenu en base (Lot 2bis)", async () => {
    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.donneesPseudonymisees).toBe(true);
    expect(action?.contenuGenere).toContain(NOM_REEL_DESTINATAIRE);
    expect(action?.contenuGenere).not.toContain("PARTIE_A");

    const rows = await prisma.$queryRawUnsafe<{ contenu_genere: string }[]>(
      `SELECT contenu_genere FROM actions WHERE id = $1`,
      actionId
    );
    expect(rows[0].contenu_genere).toMatch(/^enc:v1:/);
    expect(rows[0].contenu_genere).not.toContain(NOM_REEL_DESTINATAIRE);
  });

  it("exporte le document genere au format Word", async () => {
    const res = await api(`/api/actions/${actionId}/word`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("wordprocessingml");
    const buffer = Buffer.from(await res.arrayBuffer());
    // Un .docx est une archive ZIP - signature "PK".
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
  });

  it("exporte le document genere au format PDF", async () => {
    const res = await api(`/api/actions/${actionId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
});
