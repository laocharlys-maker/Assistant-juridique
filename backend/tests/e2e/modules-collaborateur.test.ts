/**
 * Acces aux modules restreint par le TITULAIRE pour un collaborateur precis
 * (User.modulesDesactives) - s'applique EN PLUS du reglage plateforme
 * (Cabinet.modulesDesactives), jamais au-dessus (voir middleware/roles.ts,
 * requireModule, et routes/users.ts, PATCH /api/users/:id/modules).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : modules autorisés par collaborateur", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let collaborateurId: string;
  let collaborateurCookie: string;
  let avocatId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("modules-collaborateur"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-modules-collaborateur-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "modules-collaborateur");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const collaborateur = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Collaborateur Test",
        email: "collaborateur-modules-e2e@test.invalid",
        motDePasseHash: "x",
        role: "collaborateur",
        responsableId: titulaireId,
      },
    });
    collaborateurId = collaborateur.id;
    collaborateurCookie = await mintAuthCookie(collaborateur.id, cabinetId, "collaborateur");

    const avocat = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Avocat Test",
        email: "avocat-modules-e2e@test.invalid",
        motDePasseHash: "x",
        role: "avocat",
      },
    });
    avocatId = avocat.id;
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

  it("un collaborateur ne peut pas modifier lui-même ses modules (réservé au titulaire)", async () => {
    const res = await api(collaborateurCookie, `/api/users/${collaborateurId}/modules`, {
      method: "PATCH",
      body: JSON.stringify({ modulesDesactives: ["facturation"] }),
    });
    expect(res.status).toBe(403);
  });

  it("le titulaire ne peut pas restreindre les modules d'un avocat (endpoint réservé aux collaborateurs)", async () => {
    const res = await api(titulaireCookie, `/api/users/${avocatId}/modules`, {
      method: "PATCH",
      body: JSON.stringify({ modulesDesactives: ["facturation"] }),
    });
    expect(res.status).toBe(404);
  });

  it("rejette une clé de module inconnue", async () => {
    const res = await api(titulaireCookie, `/api/users/${collaborateurId}/modules`, {
      method: "PATCH",
      body: JSON.stringify({ modulesDesactives: ["cle_inexistante"] }),
    });
    expect(res.status).toBe(400);
  });

  it("le titulaire retire l'accès à 'documents_generes' pour ce collaborateur : GET /api/users et /api/auth/me le reflètent", async () => {
    const patchRes = await api(titulaireCookie, `/api/users/${collaborateurId}/modules`, {
      method: "PATCH",
      body: JSON.stringify({ modulesDesactives: ["documents_generes"] }),
    });
    expect(patchRes.status).toBe(200);

    const listeRes = await api(titulaireCookie, "/api/users");
    const liste = await listeRes.json();
    const ligne = liste.find((u: { id: string }) => u.id === collaborateurId);
    expect(ligne.modulesDesactives).toEqual(["documents_generes"]);

    const meRes = await api(collaborateurCookie, "/api/auth/me");
    const me = await meRes.json();
    expect(me.modulesDesactives).toContain("documents_generes");
  });

  it("le module retiré bloque bien la route correspondante pour ce collaborateur (requireModule)", async () => {
    const res = await api(collaborateurCookie, "/api/documents?vue=dossiers");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("n'est pas activé pour ton compte");
  });

  it("ne bloque jamais le titulaire lui-même (restriction propre à ce collaborateur uniquement)", async () => {
    const res = await api(titulaireCookie, "/api/documents?vue=dossiers");
    expect(res.status).toBe(200);
  });

  it("réautoriser le module débloque à nouveau l'accès", async () => {
    const patchRes = await api(titulaireCookie, `/api/users/${collaborateurId}/modules`, {
      method: "PATCH",
      body: JSON.stringify({ modulesDesactives: [] }),
    });
    expect(patchRes.status).toBe(200);

    const res = await api(collaborateurCookie, "/api/documents?vue=dossiers");
    expect(res.status).toBe(200);
  });

  it("le réglage plateforme (cabinet) reste prioritaire : même sans restriction individuelle, un module désactivé pour tout le cabinet bloque aussi ce collaborateur", async () => {
    await prisma.cabinet.update({ where: { id: cabinetId }, data: { modulesDesactives: ["documents_generes"] } });
    try {
      const res = await api(collaborateurCookie, "/api/documents?vue=dossiers");
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("n'est pas activé pour votre cabinet");
    } finally {
      await prisma.cabinet.update({ where: { id: cabinetId }, data: { modulesDesactives: [] } });
    }
  });
});
