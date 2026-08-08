/**
 * "Premier lancement" (routes/auth.ts) : creation du tout premier cabinet +
 * compte titulaire SANS authentification prealable, reservee au mode
 * desktop (DATABASE_MODE=portable) et UNIQUEMENT tant qu'aucun cabinet reel
 * n'existe encore - comble l'absence de tout autre moyen de bootstrapper un
 * poste desktop fraichement installe (ou dont la base locale a ete
 * reinitialisee), sans ouvrir cette possibilite sur le VPS multi-cabinets.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : premier lancement (bootstrap cabinet desktop)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("premier-lancement"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-premier-lancement-"));
    process.env.APPDATA = fakeAppData;

    process.env.DATABASE_URL = pg.databaseUrl;
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GEMINI_API_KEY = "dummy-test-key";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";
    process.env.LICENCE_BYPASS = "true";
    // Contrairement aux autres suites e2e : ce lot teste explicitement le
    // comportement en mode desktop.
    process.env.DATABASE_MODE = "portable";

    const { app } = await import("../../src/app");
    const { prisma: prismaClient } = await import("../../src/lib/prisma");
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;
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
      headers: { "Content-Type": "application/json", ...(options.headers as Record<string, string>) },
    });
  }

  it("est indisponible en mode externe (DATABASE_MODE != portable), meme base vide", async () => {
    process.env.DATABASE_MODE = "externe";
    const statutRes = await api("/api/auth/premier-lancement");
    expect((await statutRes.json()).disponible).toBe(false);

    const creerRes = await api("/api/auth/premier-lancement", {
      method: "POST",
      body: JSON.stringify({ cabinetNom: "X", nom: "X", email: "x-premier-lancement-e2e@test.invalid", password: "motdepasse123" }),
    });
    expect(creerRes.status).toBe(403);

    process.env.DATABASE_MODE = "portable"; // repli pour la suite des tests
  });

  it("est disponible en mode portable tant qu'aucun cabinet n'existe", async () => {
    const res = await api("/api/auth/premier-lancement");
    expect((await res.json()).disponible).toBe(true);
  });

  it("cree le cabinet + le titulaire, et ouvre directement une session", async () => {
    const res = await api("/api/auth/premier-lancement", {
      method: "POST",
      body: JSON.stringify({
        cabinetNom: "Cabinet Premier Lancement E2E",
        nom: "Ada Titulaire",
        email: "ada-premier-lancement-e2e@test.invalid",
        password: "motdepasse123",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.role).toBe("titulaire");
    expect(body.email).toBe("ada-premier-lancement-e2e@test.invalid");
    expect(res.headers.get("set-cookie")).toMatch(/aurore_session=/);

    const cabinet = await prisma.cabinet.findFirst({ where: { nom: "Cabinet Premier Lancement E2E" } });
    expect(cabinet).not.toBeNull();
    const titulaire = await prisma.user.findUnique({ where: { email: "ada-premier-lancement-e2e@test.invalid" } });
    expect(titulaire?.role).toBe("titulaire");
    expect(titulaire?.cabinetId).toBe(cabinet!.id);
  });

  it("redevient indisponible une fois un cabinet reel cree", async () => {
    const res = await api("/api/auth/premier-lancement");
    expect((await res.json()).disponible).toBe(false);
  });

  it("rejette une nouvelle tentative de creation avec 409", async () => {
    const res = await api("/api/auth/premier-lancement", {
      method: "POST",
      body: JSON.stringify({
        cabinetNom: "Autre Cabinet",
        nom: "Autre",
        email: "autre-premier-lancement-e2e@test.invalid",
        password: "motdepasse123",
      }),
    });
    expect(res.status).toBe(409);
  });

  it("le mot de passe cree fonctionne bien via /api/auth/login", async () => {
    const res = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "ada-premier-lancement-e2e@test.invalid", password: "motdepasse123" }),
    });
    expect(res.status).toBe(200);
  });
});
