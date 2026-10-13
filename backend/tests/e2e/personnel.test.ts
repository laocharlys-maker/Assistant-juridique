/**
 * Module RH Cabinet, RH-1 - liste du personnel : creation (titulaire
 * uniquement), employe SANS compte Aurore, rattachement a un compte
 * existant (unique), et perimetre de lecture (titulaire voit tout,
 * avocat/collaborateur ne voient que leur propre fiche).
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

describe.skipIf(!pgAvailable)("e2e : module RH Cabinet - liste du personnel (RH-1)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let avocatCookie: string;
  let avocatId: string;
  let collaborateurCookie: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("personnel"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-personnel-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "personnel");
    cabinetId = cabinet.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const avocat = await prisma.user.create({
      data: { cabinetId, nom: "Avocat Test", email: "avocat2-e2e-personnel@test.invalid", motDePasseHash: "x", role: "avocat" },
    });
    avocatId = avocat.id;
    avocatCookie = await mintAuthCookie(avocat.id, cabinetId, "avocat");

    const collaborateur = await prisma.user.create({
      data: { cabinetId, nom: "Collaborateur Test", email: "collab-e2e-personnel@test.invalid", motDePasseHash: "x", role: "collaborateur" },
    });
    collaborateurCookie = await mintAuthCookie(collaborateur.id, cabinetId, "collaborateur");
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

  it("le titulaire peut ajouter un employe SANS compte Aurore", async () => {
    const res = await api(titulaireCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({
        nom: "Houngbo",
        prenoms: "Alice",
        categorie: "secretariat",
        typeContrat: "cdi",
        dateEntree: "2022-01-10",
      }),
    });
    expect(res.status).toBe(201);
    const fiche = await res.json();
    expect(fiche.userId).toBeNull();
    expect(fiche.statut).toBe("actif");
  });

  it("un avocat ne peut pas ajouter d'employe (reserve au titulaire)", async () => {
    const res = await api(avocatCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({ nom: "Test", categorie: "autre", typeContrat: "autre", dateEntree: "2024-01-01" }),
    });
    expect(res.status).toBe(403);
  });

  it("rattacher un compte Aurore deja rattache a une autre fiche est refuse (409)", async () => {
    const premiere = await api(titulaireCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({ nom: "Premiere", categorie: "avocat", typeContrat: "cdi", dateEntree: "2021-01-01", userId: avocatId }),
    });
    expect(premiere.status).toBe(201);

    const seconde = await api(titulaireCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({ nom: "Seconde", categorie: "avocat", typeContrat: "cdi", dateEntree: "2021-01-01", userId: avocatId }),
    });
    expect(seconde.status).toBe(409);
  });

  it("un avocat ne voit que sa propre fiche dans la liste, jamais celle des autres", async () => {
    const res = await api(avocatCookie, "/api/personnel");
    expect(res.status).toBe(200);
    const liste = await res.json();
    expect(liste.length).toBe(1);
    expect(liste[0].userId).toBe(avocatId);
  });

  it("un collaborateur sans fiche personnel voit une liste vide (pas d'erreur)", async () => {
    const res = await api(collaborateurCookie, "/api/personnel");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("un avocat ne peut pas consulter la fiche d'un autre employe (403)", async () => {
    const creation = await api(titulaireCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({ nom: "Autrui", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2023-05-01" }),
    });
    const { id } = await creation.json();

    const res = await api(avocatCookie, `/api/personnel/${id}`);
    expect(res.status).toBe(403);
  });

  it("le titulaire peut marquer un employe comme sorti, il reste consultable", async () => {
    const creation = await api(titulaireCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({ nom: "Partant", categorie: "stagiaire", typeContrat: "stage", dateEntree: "2023-09-01" }),
    });
    const { id } = await creation.json();

    const sortie = await api(titulaireCookie, `/api/personnel/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ statut: "sorti", dateSortie: "2024-02-28" }),
    });
    expect(sortie.status).toBe(200);
    expect((await sortie.json()).statut).toBe("sorti");

    const listeActifs = await api(titulaireCookie, "/api/personnel?statut=actifs");
    const listeActifsJson = await listeActifs.json();
    expect(listeActifsJson.find((p: { id: string }) => p.id === id)).toBeUndefined();

    const listeTous = await api(titulaireCookie, "/api/personnel?statut=tous");
    const listeTousJson = await listeTous.json();
    expect(listeTousJson.find((p: { id: string }) => p.id === id)).toBeDefined();
  });
});
