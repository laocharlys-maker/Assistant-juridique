/**
 * Lot 17 - routes OCR (résultat, relance, recherche plein texte) : permissions
 * (même règle que l'accès à la pièce elle-même), chiffrement/déchiffrement
 * réel du texte extrait, recherche plein texte sur contenu chiffré.
 *
 * Le chemin "upload -> déclenchement automatique -> vrai traitement
 * Tesseract" n'est PAS exercé ici : il nécessiterait un vrai moteur OCR
 * (réseau au premier appel pour le pack de langue, lent - voir
 * README-LOT17.md). Les DocumentDossier/OcrResultat sont donc créés
 * directement via Prisma (comme le Dossier lui-même dans ce fichier), pour
 * tester les ROUTES indépendamment du moteur. La relance est testée
 * uniquement sur un format non couvert par l'OCR (retour immédiat, sans
 * jamais démarrer le moteur), pour rester déterministe.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : reconnaissance de texte (OCR) des pièces (Lot 17)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;
  let encryptField: typeof import("../../src/security/encryptionAtRest").encryptField;

  let titulaireCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let dossierId: string;
  let autreCabinetCookie: string;

  let documentImageId: string;
  let documentWordId: string;

  const TEXTE_OCR = "Contrat conclu avec MOTUNIQUEDETEST le 12 janvier 2026, pour un montant convenu.";

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("ocr"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-ocr-"));
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
    ({ encryptField } = await import("../../src/security/encryptionAtRest"));
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "ocr");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const { user: autreTitulaire } = await seedCabinetEtTitulaire(prisma, "ocr-autre-cabinet");
    autreCabinetCookie = await mintAuthCookie(autreTitulaire.id, autreTitulaire.cabinetId, "titulaire");

    const dossier = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "OCR-E2E-001",
        nomAffaire: "Affaire OCR E2E",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });
    dossierId = dossier.id;

    // Cree directement via Prisma (jamais via POST /api/dossiers/:id/documents)
    // pour ne jamais declencher le vrai hook enqueuerTraitementOcr -> vrai
    // moteur Tesseract (voir en-tete de ce fichier).
    const documentImage = await prisma.documentDossier.create({
      data: {
        cabinetId,
        dossierId,
        nomOriginal: "scan-piece.jpg",
        typeMime: "image/jpeg",
        tailleOctets: 1234,
        nomFichier: "fake.enc",
        uploadeParId: titulaireId,
      },
    });
    documentImageId = documentImage.id;

    await prisma.ocrResultat.create({
      data: {
        documentId: documentImageId,
        cabinetId,
        dossierId,
        statut: "termine",
        scoreConfiance: 42,
        texteExtrait: encryptField(TEXTE_OCR),
      },
    });

    const documentWord = await prisma.documentDossier.create({
      data: {
        cabinetId,
        dossierId,
        nomOriginal: "note.docx",
        typeMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        tailleOctets: 100,
        nomFichier: "fake2.enc",
        uploadeParId: titulaireId,
      },
    });
    documentWordId = documentWord.id;
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

  it("GET /api/documents/:id/ocr renvoie le texte déchiffré et le score de confiance", async () => {
    const res = await api(titulaireCookie, `/api/documents/${documentImageId}/ocr`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statut).toBe("termine");
    expect(body.scoreConfiance).toBe(42);
    expect(body.texteExtrait).toBe(TEXTE_OCR);
  });

  it("GET /api/documents/:id/ocr renvoie 'aucun' pour une pièce sans traitement OCR (format hors périmètre)", async () => {
    const res = await api(titulaireCookie, `/api/documents/${documentWordId}/ocr`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.statut).toBe("aucun");
  });

  it("un utilisateur d'un autre cabinet ne peut pas accéder au texte OCR de cette pièce", async () => {
    const res = await api(autreCabinetCookie, `/api/documents/${documentImageId}/ocr`);
    expect(res.status).toBe(404);
  });

  it("« Documents transcrits » (Documents générés) liste la pièce transcrite, jamais celle sans OCR", async () => {
    const res = await api(titulaireCookie, "/api/documents?vue=transcriptions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vue).toBe("transcriptions");
    expect(body.documents.some((d: { id: string }) => d.id === documentImageId)).toBe(true);
    expect(body.documents.some((d: { id: string }) => d.id === documentWordId)).toBe(false);
    const piece = body.documents.find((d: { id: string }) => d.id === documentImageId);
    expect(piece.nomOriginal).toBe("scan-piece.jpg");
    expect(piece.ocrResultat.scoreConfiance).toBe(42);
  });

  it("un utilisateur d'un autre cabinet ne voit pas cette pièce dans « Documents transcrits »", async () => {
    const res = await api(autreCabinetCookie, "/api/documents?vue=transcriptions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents.some((d: { id: string }) => d.id === documentImageId)).toBe(false);
  });

  it("la recherche plein texte retrouve la pièce via un terme présent uniquement dans le texte OCR", async () => {
    const res = await api(titulaireCookie, `/api/dossiers/${dossierId}/documents/recherche-ocr?q=MOTUNIQUEDETEST`);
    expect(res.status).toBe(200);
    const resultats = await res.json();
    expect(resultats).toHaveLength(1);
    expect(resultats[0].documentId).toBe(documentImageId);
    expect(resultats[0].extrait).toContain("MOTUNIQUEDETEST");
  });

  it("la recherche plein texte ne renvoie rien pour un terme absent", async () => {
    const res = await api(titulaireCookie, `/api/dossiers/${dossierId}/documents/recherche-ocr?q=termeabsent`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("un utilisateur d'un autre cabinet ne peut pas rechercher dans les pièces de ce dossier", async () => {
    const res = await api(autreCabinetCookie, `/api/dossiers/${dossierId}/documents/recherche-ocr?q=MOTUNIQUEDETEST`);
    expect(res.status).toBe(404);
  });

  it("la relance sur un format non pris en charge par l'OCR échoue avec un message clair, sans jamais démarrer le moteur", async () => {
    const res = await api(titulaireCookie, `/api/documents/${documentWordId}/ocr/relancer`, { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("pas pris en charge");
  });

  it("un utilisateur d'un autre cabinet ne peut pas relancer l'OCR de cette pièce", async () => {
    const res = await api(autreCabinetCookie, `/api/documents/${documentImageId}/ocr/relancer`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});
