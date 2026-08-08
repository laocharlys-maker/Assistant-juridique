/**
 * Lot 15 - stockage documentaire par dossier (GED) : upload chiffré,
 * téléchargement (contenu restitué identique), suppression (base ET
 * fichier physique), rejet des types non autorisés, rejet du dépassement
 * de taille, permissions (même règle que l'accès au dossier lui-même).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

function versDataUrl(mime: string, contenu: Buffer): string {
  return `data:${mime};base64,${contenu.toString("base64")}`;
}

describe.skipIf(!pgAvailable)("e2e : stockage documentaire par dossier (Lot 15)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let dossierId: string;

  // Deuxieme cabinet, pour le test de permissions (l'acces aux pieces suit
  // exactement la meme regle que l'acces au dossier lui-meme : cabinet
  // uniquement - voir routes/documentsDossier.ts).
  let autreCabinetCookie: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("documents-dossier"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-documents-dossier-"));
    process.env.APPDATA = fakeAppData;

    process.env.DATABASE_URL = pg.databaseUrl;
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GEMINI_API_KEY = "dummy-test-key";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";
    delete process.env.DATABASE_MODE;
    process.env.LICENCE_BYPASS = "true";
    // Limite basse et deterministe pour le test de depassement de taille
    // (voir plus bas) - jamais la vraie valeur par defaut (20 Mo), qui
    // rendrait ce test lent/lourd inutilement.
    process.env.DOCUMENTS_TAILLE_MAX_MO = "1";

    const { app } = await import("../../src/app");
    const { prisma: prismaClient } = await import("../../src/lib/prisma");
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "documents-dossier");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const { user: autreTitulaire } = await seedCabinetEtTitulaire(prisma, "documents-dossier-autre-cabinet");
    autreCabinetCookie = await mintAuthCookie(autreTitulaire.id, autreTitulaire.cabinetId, "titulaire");

    const dossier = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "GED-E2E-001",
        nomAffaire: "Affaire GED E2E",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });
    dossierId = dossier.id;
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

  const contenuOriginal = Buffer.from("Ceci est le contenu original du document de test (pièce jointe).", "utf8");
  let documentId: string;
  let nomFichierSurDisque: string;

  it("upload un fichier autorisé : stocké chiffré sur disque, jamais en clair", async () => {
    const res = await api(titulaireCookie, `/api/dossiers/${dossierId}/documents`, {
      method: "POST",
      body: JSON.stringify({ nom: "piece-test.txt", fichierDataUrl: versDataUrl("text/plain", contenuOriginal) }),
    });
    expect(res.status).toBe(201);
    const document = await res.json();
    documentId = document.id;
    expect(document.nomOriginal).toBe("piece-test.txt");
    expect(document.tailleOctets).toBe(contenuOriginal.length);

    const row = await prisma.documentDossier.findUniqueOrThrow({ where: { id: documentId } });
    nomFichierSurDisque = row.nomFichier;
    // Nom sur disque non previsible (UUID), jamais le nom d'origine.
    expect(nomFichierSurDisque).not.toContain("piece-test");

    const cheminDisque = path.join(fakeAppData, "Aurore", "documents", dossierId, nomFichierSurDisque);
    expect(fs.existsSync(cheminDisque)).toBe(true);
    const brut = fs.readFileSync(cheminDisque);
    expect(brut.includes(contenuOriginal)).toBe(false);
    expect(brut.toString("latin1")).not.toContain("contenu original");
  });

  it("l'onglet Pièces liste correctement le document rattaché au dossier", async () => {
    const res = await api(titulaireCookie, `/api/dossiers/${dossierId}/documents`);
    expect(res.status).toBe(200);
    const liste = await res.json();
    expect(liste.some((d: { id: string }) => d.id === documentId)).toBe(true);
  });

  it("le téléchargement restitue le contenu original exact (déchiffré)", async () => {
    const res = await api(titulaireCookie, `/api/documents/${documentId}`);
    expect(res.status).toBe(200);
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.equals(contenuOriginal)).toBe(true);
  });

  it("rejette un type de fichier non autorisé (exécutable) avec un message clair", async () => {
    const res = await api(titulaireCookie, `/api/dossiers/${dossierId}/documents`, {
      method: "POST",
      body: JSON.stringify({
        nom: "malware.exe",
        fichierDataUrl: versDataUrl("application/x-msdownload", Buffer.from("MZ...")),
      }),
    });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toContain("non autorisé");
  });

  it("rejette un fichier dépassant la taille maximale configurée avec un message clair", async () => {
    // DOCUMENTS_TAILLE_MAX_MO=1 pour ce test (voir beforeAll) - 2 Mo dépasse.
    const grosFichier = Buffer.alloc(2 * 1024 * 1024, "a");
    const res = await api(titulaireCookie, `/api/dossiers/${dossierId}/documents`, {
      method: "POST",
      body: JSON.stringify({ nom: "gros-fichier.txt", fichierDataUrl: versDataUrl("text/plain", grosFichier) }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("volumineux");
  });

  it("un utilisateur d'un autre cabinet ne peut pas accéder aux pièces de ce dossier", async () => {
    const listeRes = await api(autreCabinetCookie, `/api/dossiers/${dossierId}/documents`);
    expect(listeRes.status).toBe(404);

    const telechargementRes = await api(autreCabinetCookie, `/api/documents/${documentId}`);
    expect(telechargementRes.status).toBe(404);

    const uploadRes = await api(autreCabinetCookie, `/api/dossiers/${dossierId}/documents`, {
      method: "POST",
      body: JSON.stringify({ nom: "intrusion.txt", fichierDataUrl: versDataUrl("text/plain", Buffer.from("x")) }),
    });
    expect(uploadRes.status).toBe(404);
  });

  it("la suppression retire l'entrée en base ET le fichier physique", async () => {
    const cheminDisque = path.join(fakeAppData, "Aurore", "documents", dossierId, nomFichierSurDisque);
    expect(fs.existsSync(cheminDisque)).toBe(true);

    const res = await api(titulaireCookie, `/api/documents/${documentId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const row = await prisma.documentDossier.findUnique({ where: { id: documentId } });
    expect(row).toBeNull();
    expect(fs.existsSync(cheminDisque)).toBe(false);
  });
});
