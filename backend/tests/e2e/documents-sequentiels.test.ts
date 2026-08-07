/**
 * Lot 11 (Partie A) - verrouillage sequentiel + historique de versions +
 * validation qui s'impose : ouverture/fermeture d'edition, sauvegarde de
 * versions successives, validation d'une version precise (fige
 * Action.contenuGenere/statut), liberation automatique d'un verrou expire.
 *
 * Tourne sur une base PostgreSQL de test jetable (voir full-workflow.test.ts).
 * Licence non testee ici (LICENCE_BYPASS), deja couverte ailleurs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : verrouillage sequentiel + versions (Lot 11, Partie A)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let collaborateurCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let collaborateurId: string;
  let dossierId: string;
  let actionId: string;
  let version2Id: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("documents-sequentiels"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-documents-sequentiels-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "documents-sequentiels");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const collaborateur = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Collaborateur Test",
        email: "collab-e2e-documents-sequentiels@test.invalid",
        motDePasseHash: "x",
        role: "collaborateur",
        responsableId: titulaireId,
      },
    });
    collaborateurId = collaborateur.id;
    collaborateurCookie = await mintAuthCookie(collaborateur.id, cabinetId, "collaborateur");

    const dossier = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "SEQ-E2E-001",
        nomAffaire: "Affaire Documents Sequentiels E2E",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });
    dossierId = dossier.id;

    const action = await prisma.action.create({
      data: {
        dossierId,
        typeAction: "mise_en_demeure",
        canal: "web",
        contenuGenere: "Contenu initial.",
        statut: "en_attente_validation",
        createdBy: collaborateurId,
      },
    });
    actionId = action.id;
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

  it("le collaborateur ouvre l'édition (prend le verrou)", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/verrou`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verrouillePar).toBe(collaborateurId);
  });

  it("bloque un second utilisateur avec un message identifiant qui détient le verrou", async () => {
    const res = await api(titulaireCookie, `/api/actions/${actionId}/verrou`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("Collaborateur Test");
  });

  it("reste idempotent pour celui qui détient déjà le verrou", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/verrou`, { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("refuse une sauvegarde de version à qui ne détient pas le verrou", async () => {
    const res = await api(titulaireCookie, `/api/actions/${actionId}/versions`, {
      method: "POST",
      body: JSON.stringify({ contenu: "Tentative non autorisée" }),
    });
    expect(res.status).toBe(403);
  });

  it("crée une première version sans modifier Action.contenuGenere", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/versions`, {
      method: "POST",
      body: JSON.stringify({ contenu: "Version 1" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.numero).toBe(1);

    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.versionActuelle).toBe(1);
    expect(action?.contenuGenere).toBe("Contenu initial.");
  });

  it("crée une deuxième version, toujours sans modifier Action.contenuGenere", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/versions`, {
      method: "POST",
      body: JSON.stringify({ contenu: "Version 2" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.numero).toBe(2);
    version2Id = body.id;

    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.versionActuelle).toBe(2);
    expect(action?.contenuGenere).toBe("Contenu initial.");
  });

  it("liste les deux versions dans l'historique, la plus récente en premier", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/versions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].numero).toBe(2);
    expect(body[1].numero).toBe(1);
    expect(body[0].auteur.nom).toBe("Collaborateur Test");
  });

  it("refuse à un collaborateur de valider une version", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/versions/${version2Id}/valider`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  it("libère le verrou explicitement (Terminer l'édition)", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/verrou`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.verrouillePar).toBeNull();
  });

  it("l'ancienne route générique /valider est bloquée dès qu'un cycle de versions a démarré", async () => {
    const res = await api(titulaireCookie, `/api/actions/${actionId}/valider`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("historique de versions");
  });

  it("l'avocat valide la version 2 : Action.contenuGenere et statut sont mis à jour", async () => {
    const res = await api(titulaireCookie, `/api/actions/${actionId}/versions/${version2Id}/valider`, {
      method: "POST",
    });
    expect(res.status).toBe(200);

    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.contenuGenere).toBe("Version 2");
    expect(action?.statut).toBe("valide");

    const versions = await prisma.actionVersion.findMany({ where: { actionId }, orderBy: { numero: "asc" } });
    expect(versions[0].estVersionValidee).toBe(false); // version 1
    expect(versions[1].estVersionValidee).toBe(true); // version 2
  });

  it("un document validé ne peut plus être rouvert en édition directement", async () => {
    const res = await api(titulaireCookie, `/api/actions/${actionId}/verrou`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("bloque la validation d'une version tant qu'une remarque de révision reste ouverte", async () => {
    const dossier2 = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "SEQ-E2E-002",
        nomAffaire: "Affaire Documents Sequentiels E2E 2",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });
    const action2 = await prisma.action.create({
      data: {
        dossierId: dossier2.id,
        typeAction: "mise_en_demeure",
        canal: "web",
        contenuGenere: "Contenu initial 2.",
        statut: "en_attente_validation",
        createdBy: collaborateurId,
      },
    });

    await api(collaborateurCookie, `/api/actions/${action2.id}/verrou`, { method: "POST" });
    const versionRes = await api(collaborateurCookie, `/api/actions/${action2.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ contenu: "Version A" }),
    });
    const version = await versionRes.json();

    // Une remarque ouverte fait automatiquement passer le document en
    // revision_demandee (Lot 10) - la validation d'une version doit rester
    // bloquee tant qu'elle n'est pas resolue.
    await api(titulaireCookie, `/api/actions/${action2.id}/commentaires`, {
      method: "POST",
      body: JSON.stringify({ contenu: "À corriger avant validation." }),
    });

    const res = await api(titulaireCookie, `/api/actions/${action2.id}/versions/${version.id}/valider`, {
      method: "POST",
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("remarque");
  });

  it("libère automatiquement un verrou expiré (job de fond)", async () => {
    const dossier3 = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "SEQ-E2E-003",
        nomAffaire: "Affaire Documents Sequentiels E2E 3",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });
    const action3 = await prisma.action.create({
      data: {
        dossierId: dossier3.id,
        typeAction: "mise_en_demeure",
        canal: "web",
        contenuGenere: "Contenu initial 3.",
        statut: "en_attente_validation",
        createdBy: collaborateurId,
        // Verrou pris il y a 5h - au-dela du delai par defaut (4h).
        verrouillePar: collaborateurId,
        verrouilleLe: new Date(Date.now() - 5 * 60 * 60 * 1000),
      },
    });

    const { runLiberationVerrousExpires } = await import("../../src/jobs/liberationVerrousExpires");
    const liberes = await runLiberationVerrousExpires();
    expect(liberes).toBeGreaterThanOrEqual(1);

    const action = await prisma.action.findUnique({ where: { id: action3.id } });
    expect(action?.verrouillePar).toBeNull();
    expect(action?.verrouilleLe).toBeNull();
  });

  it("un verrou expiré peut aussi être repris directement (sans attendre le job)", async () => {
    const dossier4 = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "SEQ-E2E-004",
        nomAffaire: "Affaire Documents Sequentiels E2E 4",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });
    const action4 = await prisma.action.create({
      data: {
        dossierId: dossier4.id,
        typeAction: "mise_en_demeure",
        canal: "web",
        contenuGenere: "Contenu initial 4.",
        statut: "en_attente_validation",
        createdBy: collaborateurId,
        verrouillePar: collaborateurId,
        verrouilleLe: new Date(Date.now() - 5 * 60 * 60 * 1000),
      },
    });

    const res = await api(titulaireCookie, `/api/actions/${action4.id}/verrou`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verrouillePar).toBe(titulaireId);
  });
});
