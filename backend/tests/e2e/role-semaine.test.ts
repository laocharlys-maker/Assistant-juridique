/**
 * "Rôle de la semaine" (refonte) - navigation par semaine (semaine suivante
 * par défaut, plus de garde-fou jeudi-dimanche), fusion des audiences
 * (RoleAudience, données riches) et des autres événements (Evenement, via
 * GET /api/evenements déjà existant), filtre par type appliqué à l'export
 * PDF/Word (deux sections distinctes).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

function lundiDeLaSemaineSuivante(): Date {
  const now = new Date();
  const jour = now.getUTCDay();
  const decalage = jour === 0 ? -6 : 1 - jour;
  const lundiCetteSemaine = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + decalage));
  const lundiSuivant = new Date(lundiCetteSemaine);
  lundiSuivant.setUTCDate(lundiSuivant.getUTCDate() + 7);
  return lundiSuivant;
}

describe.skipIf(!pgAvailable)('e2e : "Rôle de la semaine" (navigation par semaine + tous les événements)', () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;
  let authCookie: string;

  async function api(urlPath: string, options: RequestInit = {}) {
    return fetch(`${baseUrl}${urlPath}`, {
      ...options,
      headers: { "Content-Type": "application/json", Cookie: authCookie, ...(options.headers as Record<string, string>) },
    });
  }

  const lundiSuivant = lundiDeLaSemaineSuivante();
  const dateAudience = new Date(lundiSuivant);
  dateAudience.setUTCDate(dateAudience.getUTCDate() + 1);
  dateAudience.setUTCHours(10, 0, 0, 0);
  const dateTache = new Date(lundiSuivant);
  dateTache.setUTCDate(dateTache.getUTCDate() + 2);
  dateTache.setUTCHours(14, 0, 0, 0);

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("role-semaine"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-role-semaine-"));
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

    const { user } = await seedCabinetEtTitulaire(prisma, "role-semaine");
    authCookie = await mintAuthCookie(user.id, user.cabinetId, "titulaire");

    const audienceRes = await api("/api/role-audiences", {
      method: "POST",
      body: JSON.stringify({
        dateAudience: dateAudience.toISOString(),
        juridiction: "TPI Cotonou",
        parties: "Koffi C/ Kodjo",
      }),
    });
    if (audienceRes.status !== 201) throw new Error(`setup audience: ${await audienceRes.text()}`);

    const tacheRes = await api("/api/evenements", {
      method: "POST",
      body: JSON.stringify({
        type: "tache",
        titre: "Relancer le greffe",
        dateDebut: dateTache.toISOString(),
      }),
    });
    if (tacheRes.status !== 201) throw new Error(`setup tache: ${await tacheRes.text()}`);
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    pg?.stop();
    if (fakeAppData) fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  it("GET /api/role-audiences/semaine, sans paramètre, renvoie par défaut la semaine SUIVANTE (pas sur-prochaine)", async () => {
    const res = await api("/api/role-audiences/semaine");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new Date(body.debut).toISOString()).toBe(lundiSuivant.toISOString());
    expect(body.audiences.some((a: { parties: string }) => a.parties === "Koffi C/ Kodjo")).toBe(true);
  });

  it("GET /api/evenements sur la même période renvoie tous les types d'événements, pas seulement les audiences", async () => {
    const debut = lundiSuivant.toISOString();
    const fin = new Date(lundiSuivant);
    fin.setUTCDate(fin.getUTCDate() + 7);
    const res = await api(`/api/evenements?debut=${encodeURIComponent(debut)}&fin=${encodeURIComponent(fin.toISOString())}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.evenements.some((e: { titre: string }) => e.titre === "Relancer le greffe")).toBe(true);
  });

  it("la navigation vers une semaine arbitraire fonctionne (paramètre debut)", async () => {
    const semaineSuivanteEncore = new Date(lundiSuivant);
    semaineSuivanteEncore.setUTCDate(semaineSuivanteEncore.getUTCDate() + 7);
    const res = await api(`/api/role-audiences/semaine?debut=${encodeURIComponent(semaineSuivanteEncore.toISOString())}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(new Date(body.debut).toISOString()).toBe(semaineSuivanteEncore.toISOString());
    // Rien saisi pour cette semaine-la dans ce test.
    expect(body.audiences).toHaveLength(0);
  });

  it("l'ancienne route « semaine-sur-prochaine » n'existe plus", async () => {
    const res = await api("/api/role-audiences/semaine-sur-prochaine");
    expect(res.status).toBe(404);
  });

  it("export PDF filtré sur types=audience : uniquement la section audiences", async () => {
    const res = await api(`/api/role-audiences/semaine/pdf?debut=${encodeURIComponent(lundiSuivant.toISOString())}&types=audience`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("export PDF filtré sur types=tache : uniquement la section autres événements", async () => {
    const res = await api(`/api/role-audiences/semaine/pdf?debut=${encodeURIComponent(lundiSuivant.toISOString())}&types=tache`);
    expect(res.status).toBe(200);
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("export PDF filtré sur un type absent cette semaine-là échoue avec un message clair", async () => {
    const res = await api(`/api/role-audiences/semaine/pdf?debut=${encodeURIComponent(lundiSuivant.toISOString())}&types=rdv`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Aucun événement à exporter");
  });

  it("export Word par défaut (tous les types) réussit avec audiences et autres événements combinés", async () => {
    const res = await api(`/api/role-audiences/semaine/word?debut=${encodeURIComponent(lundiSuivant.toISOString())}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
  });
});
