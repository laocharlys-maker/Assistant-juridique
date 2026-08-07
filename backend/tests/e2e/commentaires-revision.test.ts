/**
 * Lot 10 - remarques de revision (avocat/titulaire -> collaborateur) : cycle
 * complet en_attente_validation -> revision_demandee (commentaire ajoute) ->
 * resolution -> renvoyer-validation -> en_attente_validation -> valider.
 *
 * Tourne sur une base PostgreSQL de test jetable (voir tests/e2e/full-workflow.test.ts).
 * Licence non testee ici (LICENCE_BYPASS), deja couverte par les autres
 * suites e2e - ce fichier se concentre sur le cycle statut/permissions du
 * Lot 10, independant de la generation IA.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : remarques de revision (Lot 10)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let autreAvocatCookie: string;
  let collaborateurCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let collaborateurId: string;
  let actionId: string;
  let commentaireId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("commentaires-revision"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-commentaires-revision-"));
    process.env.APPDATA = fakeAppData;

    process.env.DATABASE_URL = pg.databaseUrl;
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GEMINI_API_KEY = "dummy-test-key";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";
    delete process.env.DATABASE_MODE;
    process.env.LICENCE_BYPASS = "true"; // licence non testee ici - voir full-workflow.test.ts

    const { app } = await import("../../src/app");
    const { prisma: prismaClient } = await import("../../src/lib/prisma");
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "commentaires-revision");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const autreAvocat = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Avocat Secondaire",
        email: "avocat2-e2e-commentaires-revision@test.invalid",
        motDePasseHash: "x",
        role: "avocat",
      },
    });
    autreAvocatCookie = await mintAuthCookie(autreAvocat.id, cabinetId, "avocat");

    const collaborateur = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Collaborateur Test",
        email: "collab-e2e-commentaires-revision@test.invalid",
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
        numeroDossier: "COM-E2E-001",
        nomAffaire: "Affaire Commentaires E2E",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });

    const action = await prisma.action.create({
      data: {
        dossierId: dossier.id,
        typeAction: "mise_en_demeure",
        canal: "web",
        contenuGenere: "Contenu genere de test.",
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

  it("refuse à un collaborateur de laisser une remarque", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/commentaires`, {
      method: "POST",
      body: JSON.stringify({ contenu: "Ceci ne devrait pas passer." }),
    });
    expect(res.status).toBe(403);
  });

  it("permet à l'avocat responsable de laisser une remarque, passe le document en revision_demandee", async () => {
    const res = await api(titulaireCookie, `/api/actions/${actionId}/commentaires`, {
      method: "POST",
      body: JSON.stringify({ contenu: "Renforcer le paragraphe sur le délai de mise en conformité." }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    commentaireId = body.id;
    expect(body.statut).toBe("ouvert");

    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.statut).toBe("revision_demandee");
  });

  it("liste la remarque via GET", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/commentaires`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(commentaireId);
    expect(body[0].auteur.nom).toBe("Avocat Test");
  });

  it("bloque la validation tant que la remarque reste ouverte", async () => {
    const res = await api(titulaireCookie, `/api/actions/${actionId}/valider`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("bloque le renvoi pour validation tant que la remarque reste ouverte", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/renvoyer-validation`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  it("refuse à un avocat n'ayant ni rédigé le document ni écrit la remarque de la résoudre", async () => {
    const res = await api(autreAvocatCookie, `/api/actions/${actionId}/commentaires/${commentaireId}/resoudre`, {
      method: "PATCH",
    });
    expect(res.status).toBe(403);
  });

  it("permet au collaborateur qui a rédigé le document de résoudre la remarque", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/commentaires/${commentaireId}/resoudre`, {
      method: "PATCH",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statut).toBe("resolu");
    expect(body.resoluPar.nom).toBe("Collaborateur Test");
  });

  it("permet alors de renvoyer pour validation", async () => {
    const res = await api(collaborateurCookie, `/api/actions/${actionId}/renvoyer-validation`, { method: "POST" });
    expect(res.status).toBe(200);

    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.statut).toBe("en_attente_validation");
  });

  it("permet enfin de valider le document, plus aucune remarque ouverte", async () => {
    const res = await api(titulaireCookie, `/api/actions/${actionId}/valider`, { method: "POST" });
    expect(res.status).toBe(200);

    const action = await prisma.action.findUnique({ where: { id: actionId } });
    expect(action?.statut).toBe("valide");
  });

  it("conserve l'historique de la remarque résolue (jamais supprimée)", async () => {
    const commentaires = await prisma.commentaireRevision.findMany({ where: { actionId } });
    expect(commentaires).toHaveLength(1);
    expect(commentaires[0].statut).toBe("resolu");
  });
});
