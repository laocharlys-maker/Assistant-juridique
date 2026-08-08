/**
 * Lot 16 - ingestion email assistee : connexion IMAP (rejet si injoignable),
 * polling (metadonnees uniquement - JAMAIS de creation automatique de
 * DocumentDossier/Evenement, meme apres plusieurs cycles), suggestion de
 * dossier (correspondance exacte Client.email), import explicite d'une piece
 * jointe (traçabilite emailOrigineId), confirmation explicite d'un evenement
 * (avec correction de date), permissions (boite mail strictement
 * individuelle - un autre utilisateur du MEME cabinet ne voit ni n'agit sur
 * les emails d'autrui), deconnexion (aucune donnee deja importee affectee).
 *
 * Les clients Gmail/IMAP (appels reseau reels vers des services externes)
 * sont mockes - aucune boite mail reelle n'est disponible dans cet
 * environnement. Le mock intercepte exactement a la frontiere
 * `services/emailIngestion/{gmailClient,imapClient}.ts` : tout le reste
 * (routes, polling, detection de date, suggestion de dossier, chiffrement
 * Prisma) tourne en conditions reelles contre une vraie base PostgreSQL
 * jetable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

const { imapMock, gmailMock } = vi.hoisted(() => ({
  imapMock: {
    listerEmailsRecents: vi.fn(),
    telechargerPieceJointe: vi.fn(),
    testerConnexion: vi.fn(),
  },
  gmailMock: {
    buildGmailAuthUrl: vi.fn(),
    exchangeCodeForTokens: vi.fn(),
    listerEmailsRecents: vi.fn(),
    telechargerPieceJointe: vi.fn(),
  },
}));
vi.mock("../../src/services/emailIngestion/imapClient", () => imapMock);
vi.mock("../../src/services/emailIngestion/gmailClient", () => gmailMock);

describe.skipIf(!pgAvailable)("e2e : ingestion email assistée (Lot 16)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;
  let runPollingCycle: () => Promise<void>;

  let cabinetId: string;
  let titulaireId: string;
  let titulaireCookie: string;
  let dossierId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("ingestion-email"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-ingestion-email-"));
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
    ({ runPollingCycle } = await import("../../src/services/emailIngestion/polling"));
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "ingestion-email");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const client = await prisma.client.create({
      data: { cabinetId, nom: "Koffi Jean", email: "koffi.jean@exemple.test" },
    });
    const dossier = await prisma.dossier.create({
      data: {
        cabinetId,
        clientId: client.id,
        numeroDossier: "EMAIL-E2E-001",
        nomAffaire: "Affaire Koffi",
        nomClient: "Koffi Jean",
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

  let connexionId: string;

  it("rejette une connexion IMAP injoignable avec un message clair", async () => {
    imapMock.testerConnexion.mockRejectedValueOnce(new Error("connexion refusée"));
    const res = await api(titulaireCookie, "/api/email-ingestion/imap", {
      method: "POST",
      body: JSON.stringify({
        imapHost: "imap.inexistant.test",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "koffi@exemple.test",
        imapPassword: "secret",
      }),
    });
    expect(res.status).toBe(502);
  });

  it("connecte une boîte IMAP : les identifiants sont chiffrés au repos", async () => {
    imapMock.testerConnexion.mockResolvedValueOnce(undefined);
    const res = await api(titulaireCookie, "/api/email-ingestion/imap", {
      method: "POST",
      body: JSON.stringify({
        imapHost: "imap.exemple.test",
        imapPort: 993,
        imapSecure: true,
        imapUsername: "koffi@exemple.test",
        imapPassword: "mot-de-passe-secret",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    connexionId = body.id;
    expect(JSON.stringify(body)).not.toContain("mot-de-passe-secret");

    const rows = await prisma.$queryRawUnsafe<{ imap_password: string }[]>(
      `SELECT imap_password FROM connexions_email_externe WHERE id = $1`,
      connexionId
    );
    expect(rows[0].imap_password).toMatch(/^enc:v1:/);

    const connexion = await prisma.connexionEmailExterne.findUnique({ where: { id: connexionId } });
    expect(connexion?.imapPassword).toBe("mot-de-passe-secret");
  });

  it("le statut ne renvoie jamais le mot de passe", async () => {
    const res = await api(titulaireCookie, "/api/email-ingestion/statut");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain("mot-de-passe-secret");
  });

  let emailId: string;

  it("le polling peuple 'Boîte de réception' SANS jamais créer de document ni d'événement", async () => {
    imapMock.listerEmailsRecents.mockResolvedValue([
      {
        identifiantExterne: "101",
        expediteurEmail: "koffi.jean@exemple.test",
        expediteurNom: "Koffi Jean",
        objet: "Pièce du dossier",
        dateReception: new Date(2026, 7, 4, 8, 0, 0),
        corpsTexte: "Bonjour, le rendez-vous est fixé au 12/08/2026 à 10h30. Merci de trouver la pièce jointe.",
        piecesJointes: [{ id: "part2", nomFichier: "convocation.pdf", typeMime: "application/pdf", tailleOctets: 4242 }],
      },
    ]);

    await runPollingCycle();
    await runPollingCycle();
    await runPollingCycle(); // plusieurs cycles - critere d'acceptation explicite du prompt

    const documentsAvant = await prisma.documentDossier.count({ where: { dossierId } });
    const evenementsAvant = await prisma.evenement.count({ where: { cabinetId } });
    expect(documentsAvant).toBe(0);
    expect(evenementsAvant).toBe(0);

    const res = await api(titulaireCookie, "/api/email-ingestion/emails");
    expect(res.status).toBe(200);
    const emails = await res.json();
    expect(emails).toHaveLength(1);
    emailId = emails[0].id;
    expect(emails[0].statut).toBe("nouveau");
    expect(emails[0].piecesJointes).toHaveLength(1);
    expect(new Date(emails[0].dateDetectee).getDate()).toBe(12);
    expect(emails[0].dossiersSuggeres).toHaveLength(1);
    expect(emails[0].dossiersSuggeres[0].id).toBe(dossierId);

    // Un re-polling avec le meme identifiant externe ne duplique jamais la ligne.
    const count = await prisma.emailImporte.count({ where: { identifiantExterne: "101" } });
    expect(count).toBe(1);
  });

  it("importe explicitement la pièce jointe vers le dossier choisi (source=email, traçabilité)", async () => {
    imapMock.telechargerPieceJointe.mockResolvedValueOnce(Buffer.from("contenu pdf simulé"));

    const res = await api(titulaireCookie, `/api/email-ingestion/emails/${emailId}/importer-piece`, {
      method: "POST",
      body: JSON.stringify({ attachmentId: "part2", dossierId }),
    });
    expect(res.status).toBe(201);
    const document = await res.json();
    expect(document.source).toBe("email");
    expect(document.emailOrigineId).toBe(emailId);
    expect(document.nomOriginal).toBe("convocation.pdf");

    const listeRes = await api(titulaireCookie, `/api/dossiers/${dossierId}/documents`);
    const liste = await listeRes.json();
    expect(liste.some((d: { id: string }) => d.id === document.id)).toBe(true);

    const emailApres = await prisma.emailImporte.findUniqueOrThrow({ where: { id: emailId } });
    expect(emailApres.statut).toBe("traite");
  });

  let evenementId: string;

  it("confirme un événement à partir de la date détectée, AVEC correction de l'heure par l'utilisateur", async () => {
    const dateCorrigee = new Date(2026, 7, 12, 11, 15, 0).toISOString(); // corrige 10h30 -> 11h15
    const res = await api(titulaireCookie, `/api/email-ingestion/emails/${emailId}/confirmer-evenement`, {
      method: "POST",
      body: JSON.stringify({ type: "rdv", titre: "RDV client Koffi", dateDebut: dateCorrigee, dossierId }),
    });
    expect(res.status).toBe(201);
    const evenement = await res.json();
    evenementId = evenement.id;
    expect(evenement.source).toBe("email");
    expect(new Date(evenement.dateDebut).getHours()).toBe(11);
    expect(new Date(evenement.dateDebut).getMinutes()).toBe(15);
    expect(evenement.dossierId).toBe(dossierId);
  });

  it("un utilisateur SANS connexion mail ne voit et ne peut agir sur AUCUN email d'autrui (boîte individuelle)", async () => {
    const avocat = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Avocat Sans Boîte",
        email: "avocat-sans-boite-e2e-ingestion@test.invalid",
        motDePasseHash: "x",
        role: "avocat",
      },
    });
    const cookieAvocat = await mintAuthCookie(avocat.id, cabinetId, "avocat");

    const listeRes = await api(cookieAvocat, "/api/email-ingestion/emails");
    expect(listeRes.status).toBe(200);
    expect(await listeRes.json()).toEqual([]);

    const ignorerRes = await api(cookieAvocat, `/api/email-ingestion/emails/${emailId}/ignorer`, { method: "POST" });
    expect(ignorerRes.status).toBe(404);

    const statutRes = await api(cookieAvocat, "/api/email-ingestion/statut");
    expect(await statutRes.json()).toEqual([]);
  });

  it("la déconnexion n'affecte ni le document ni l'événement déjà créés", async () => {
    const deleteRes = await api(titulaireCookie, `/api/email-ingestion/${connexionId}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(200);

    const connexion = await prisma.connexionEmailExterne.findUnique({ where: { id: connexionId } });
    expect(connexion).toBeNull();

    // L'EmailImporte associé disparaît (cascade)...
    const email = await prisma.emailImporte.findUnique({ where: { id: emailId } });
    expect(email).toBeNull();

    // ...mais le document et l'événement déjà créés restent intacts.
    const documentRes = await api(titulaireCookie, `/api/dossiers/${dossierId}/documents`);
    const documents = await documentRes.json();
    expect(documents.length).toBeGreaterThan(0);
    expect(documents[0].emailOrigineId).toBeNull(); // SetNull, jamais supprimé

    const evenement = await prisma.evenement.findUnique({ where: { id: evenementId } });
    expect(evenement).not.toBeNull();
    expect(evenement?.titre).toBe("RDV client Koffi");
  });
});
