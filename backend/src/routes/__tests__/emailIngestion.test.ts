import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * Regression : "Boîte de réception" -> "Connecter une boîte mail" faisait
 * planter TOUTE l'application (pas juste renvoyer une erreur) - voir logs
 * serveur, "[fatal] rejet de promesse non rattrapee - arret du process
 * apres nettoyage". Cause : plusieurs routes de routes/emailIngestion.ts
 * n'avaient AUCUN try/catch autour de leurs appels Prisma (dont
 * suggererDossiers(), qui lit Client.email/nom - des champs chiffres au
 * repos, voir security/prismaEncryption.ts - un enregistrement corrompu y
 * suffit a faire planter tout le process, meme raisonnement documente sur
 * d'autres routes de ce type, ex. jurisprudenceBase.ts).
 *
 * Ce fichier verifie que CHAQUE route de ce routeur repond desormais
 * proprement (500, pas une exception qui s'echappe du handler Express) si
 * son appel Prisma sous-jacent echoue - la seule chose testable ici, la
 * garantie "le process entier ne s'arrete plus" venant de l'ajout du
 * try/catch lui-meme (verifiable a la lecture du code, pas par un test qui
 * ferait realistement planter le process de test).
 */

const prismaMock = vi.hoisted(() => ({
  connexionEmailExterne: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
  emailImporte: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  documentDossier: { create: vi.fn() },
  evenement: { create: vi.fn() },
  dossier: { findFirst: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
    next();
  },
}));

vi.mock("../../services/emailIngestion/gmailClient", () => ({
  buildGmailAuthUrl: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  telechargerPieceJointe: vi.fn(),
  obtenirContenuComplet: vi.fn(),
  envoyerReponse: vi.fn(),
}));
vi.mock("../../services/emailIngestion/imapClient", () => ({
  testerConnexion: vi.fn(),
  telechargerPieceJointe: vi.fn(),
  obtenirContenuComplet: vi.fn(),
  envoyerReponse: vi.fn(),
}));
const suggererDossiersMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/emailIngestion/suggestionDossier", () => ({ suggererDossiers: suggererDossiersMock }));
const verifierConnexionMaintenantMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/emailIngestion/polling", () => ({ verifierConnexionMaintenant: verifierConnexionMaintenantMock }));
vi.mock("../../services/stockageDocuments", () => ({ enregistrerFichier: vi.fn() }));
vi.mock("../../services/calendrierSync/syncQueue", () => ({ enqueuerSyncEvenement: vi.fn() }));

let server: Server;
let baseUrl: string;

async function api(urlPath: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}${urlPath}`, {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

beforeAll(async () => {
  const { emailIngestionRouter } = await import("../emailIngestion");
  const app = express();
  app.use(express.json());
  app.use(emailIngestionRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

const ERREUR_DB = new Error("PrismaClientKnownRequestError simulée (ex: champ chiffré corrompu)");

describe("GET /api/email-ingestion/statut - régression crash total de l'app", () => {
  it("renvoie 500 (jamais une exception non rattrapée) si le Prisma findMany échoue", async () => {
    prismaMock.connexionEmailExterne.findMany.mockRejectedValue(ERREUR_DB);
    const res = await api("/api/email-ingestion/statut");
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("comportement nominal inchangé (succès)", async () => {
    prismaMock.connexionEmailExterne.findMany.mockResolvedValue([]);
    const res = await api("/api/email-ingestion/statut");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/email-ingestion/:id/verifier-maintenant", () => {
  it("déclenche verifierConnexionMaintenant et renvoie la dernière erreur à jour", async () => {
    prismaMock.connexionEmailExterne.findFirst.mockResolvedValue({ id: "conn-1", userId: "user-1", provider: "imap" });
    verifierConnexionMaintenantMock.mockResolvedValue(undefined);
    prismaMock.connexionEmailExterne.findUnique.mockResolvedValue({ derniereErreur: "Connection not available" });

    const res = await api("/api/email-ingestion/conn-1/verifier-maintenant", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, derniereErreur: "Connection not available" });
    expect(verifierConnexionMaintenantMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conn-1" }),
      "cabinet-1"
    );
  });

  it("renvoie 404 si la connexion n'appartient pas à l'utilisateur (ou n'existe pas)", async () => {
    prismaMock.connexionEmailExterne.findFirst.mockResolvedValue(null);
    const res = await api("/api/email-ingestion/conn-1/verifier-maintenant", { method: "POST" });
    expect(res.status).toBe(404);
    expect(verifierConnexionMaintenantMock).not.toHaveBeenCalled();
  });

  it("renvoie 500 (jamais une exception non rattrapée) si le Prisma findFirst échoue", async () => {
    prismaMock.connexionEmailExterne.findFirst.mockRejectedValue(ERREUR_DB);
    const res = await api("/api/email-ingestion/conn-1/verifier-maintenant", { method: "POST" });
    expect(res.status).toBe(500);
  });
});

describe("GET /api/email-ingestion/emails - régression crash total de l'app", () => {
  it("renvoie 500 si suggererDossiers() échoue (ex: décryptage Client.email corrompu)", async () => {
    prismaMock.emailImporte.findMany.mockResolvedValue([
      { id: "e1", expediteurEmail: "x@test.fr", expediteurNom: "X", objet: "obj", dateReception: new Date(), piecesJointes: [], dateDetectee: null, dateDetecteeContexte: null, statut: "nouveau" },
    ]);
    suggererDossiersMock.mockRejectedValue(ERREUR_DB);
    const res = await api("/api/email-ingestion/emails");
    expect(res.status).toBe(500);
  });

  it("renvoie 500 si le Prisma findMany échoue", async () => {
    prismaMock.emailImporte.findMany.mockRejectedValue(ERREUR_DB);
    const res = await api("/api/email-ingestion/emails");
    expect(res.status).toBe(500);
  });

  it("comportement nominal inchangé (succès)", async () => {
    prismaMock.emailImporte.findMany.mockResolvedValue([]);
    const res = await api("/api/email-ingestion/emails");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /api/email-ingestion/emails/:id/ignorer - régression crash total de l'app", () => {
  it("renvoie 500 si le Prisma findFirst échoue", async () => {
    prismaMock.emailImporte.findFirst.mockRejectedValue(ERREUR_DB);
    const res = await api("/api/email-ingestion/emails/e1/ignorer", { method: "POST" });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/email-ingestion/emails/:id/confirmer-evenement - régression crash total de l'app", () => {
  it("renvoie 500 si le Prisma evenement.create échoue", async () => {
    prismaMock.emailImporte.findFirst.mockResolvedValue({
      id: "e1",
      piecesJointes: [],
      connexion: { userId: "user-1" },
    });
    prismaMock.evenement.create.mockRejectedValue(ERREUR_DB);
    const res = await api("/api/email-ingestion/emails/e1/confirmer-evenement", {
      method: "POST",
      body: { titre: "RDV", dateDebut: new Date().toISOString() },
    });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/email-ingestion/emails/:id/importer-piece - régression crash total de l'app", () => {
  it("renvoie 500 si le Prisma documentDossier.create échoue (après téléchargement réussi de la pièce)", async () => {
    const { telechargerPieceJointe } = await import("../../services/emailIngestion/imapClient");
    vi.mocked(telechargerPieceJointe).mockResolvedValue(Buffer.from("contenu"));
    const { enregistrerFichier } = await import("../../services/stockageDocuments");
    vi.mocked(enregistrerFichier).mockResolvedValue({ nomFichier: "f.enc", tailleOctets: 10 });

    prismaMock.emailImporte.findFirst.mockResolvedValue({
      id: "e1",
      piecesJointes: [{ id: "p1", nomFichier: "piece.pdf", typeMime: "application/pdf", tailleOctets: 10 }],
      connexion: { userId: "user-1", provider: "imap" },
      identifiantExterne: "ext-1",
    });
    prismaMock.dossier.findFirst.mockResolvedValue({ id: "dossier-1" });
    prismaMock.documentDossier.create.mockRejectedValue(ERREUR_DB);

    const res = await api("/api/email-ingestion/emails/e1/importer-piece", {
      method: "POST",
      body: { attachmentId: "p1", dossierId: "11111111-1111-1111-1111-111111111111" },
    });
    expect(res.status).toBe(500);
  });
});

describe("GET /api/email-ingestion/emails/:id/contenu", () => {
  it("renvoie le contenu du fournisseur, sans jamais écrire en base (aucun appel Prisma d'écriture)", async () => {
    const { obtenirContenuComplet } = await import("../../services/emailIngestion/gmailClient");
    vi.mocked(obtenirContenuComplet).mockResolvedValue({
      html: null,
      texte: "Bonjour, voici le corps complet de l'email.",
    });
    prismaMock.emailImporte.findFirst.mockResolvedValue({
      id: "e1",
      identifiantExterne: "ext-1",
      connexion: { userId: "user-1", provider: "gmail" },
    });

    const res = await api("/api/email-ingestion/emails/e1/contenu");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ html: null, texte: "Bonjour, voici le corps complet de l'email." });
    // Aucune des methodes d'ecriture Prisma mockees n'est appelee par cette route.
    expect(prismaMock.emailImporte.update).not.toHaveBeenCalled();
  });

  it("route vers imapClient quand connexion.provider === 'imap'", async () => {
    const { obtenirContenuComplet: obtenirContenuCompletImap } = await import("../../services/emailIngestion/imapClient");
    const { obtenirContenuComplet: obtenirContenuCompletGmail } = await import("../../services/emailIngestion/gmailClient");
    vi.mocked(obtenirContenuCompletImap).mockResolvedValue({ html: null, texte: "Texte IMAP" });
    prismaMock.emailImporte.findFirst.mockResolvedValue({
      id: "e1",
      identifiantExterne: "42",
      connexion: { userId: "user-1", provider: "imap" },
    });

    const res = await api("/api/email-ingestion/emails/e1/contenu");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ html: null, texte: "Texte IMAP" });
    expect(obtenirContenuCompletImap).toHaveBeenCalledWith(expect.objectContaining({ provider: "imap" }), "42");
    expect(obtenirContenuCompletGmail).not.toHaveBeenCalled();
  });

  it("renvoie 404 si l'email n'appartient pas à l'utilisateur (ou n'existe pas)", async () => {
    prismaMock.emailImporte.findFirst.mockResolvedValue(null);
    const res = await api("/api/email-ingestion/emails/e1/contenu");
    expect(res.status).toBe(404);
  });

  it("renvoie 502 (jamais une exception non rattrapée) si le fournisseur échoue", async () => {
    const { obtenirContenuComplet } = await import("../../services/emailIngestion/gmailClient");
    vi.mocked(obtenirContenuComplet).mockRejectedValue(new Error("Gmail : échec de récupération de l'email (HTTP 404)"));
    prismaMock.emailImporte.findFirst.mockResolvedValue({
      id: "e1",
      identifiantExterne: "ext-1",
      connexion: { userId: "user-1", provider: "gmail" },
    });

    const res = await api("/api/email-ingestion/emails/e1/contenu");
    expect(res.status).toBe(502);
  });
});

describe("POST /api/email-ingestion/emails/:id/repondre", () => {
  it("envoie la réponse via le bon fournisseur avec les bons destinataire/sujet/corps", async () => {
    const { envoyerReponse } = await import("../../services/emailIngestion/gmailClient");
    vi.mocked(envoyerReponse).mockResolvedValue(undefined);
    prismaMock.emailImporte.findFirst.mockResolvedValue({
      id: "e1",
      identifiantExterne: "ext-1",
      expediteurEmail: "client@exemple.fr",
      objet: "Question sur mon dossier",
      connexion: { userId: "user-1", provider: "gmail" },
    });

    const res = await api("/api/email-ingestion/emails/e1/repondre", {
      method: "POST",
      body: { corps: "Bonjour, je reviens vers vous." },
    });

    expect(res.status).toBe(200);
    expect(envoyerReponse).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gmail" }),
      {
        identifiantExterne: "ext-1",
        destinataire: "client@exemple.fr",
        sujet: "Question sur mon dossier",
        corps: "Bonjour, je reviens vers vous.",
      }
    );
  });

  it("renvoie 400 si le corps du message est vide", async () => {
    prismaMock.emailImporte.findFirst.mockResolvedValue({
      id: "e1",
      identifiantExterne: "ext-1",
      connexion: { userId: "user-1", provider: "gmail" },
    });
    const res = await api("/api/email-ingestion/emails/e1/repondre", { method: "POST", body: { corps: "" } });
    expect(res.status).toBe(400);
  });

  it("renvoie 404 si l'email n'appartient pas à l'utilisateur (ou n'existe pas)", async () => {
    prismaMock.emailImporte.findFirst.mockResolvedValue(null);
    const res = await api("/api/email-ingestion/emails/e1/repondre", { method: "POST", body: { corps: "Bonjour" } });
    expect(res.status).toBe(404);
  });

  it("renvoie 502 avec le message d'erreur du fournisseur (jamais une exception non rattrapée) - ex: reconnexion Gmail nécessaire", async () => {
    const { envoyerReponse } = await import("../../services/emailIngestion/gmailClient");
    vi.mocked(envoyerReponse).mockRejectedValue(
      new Error("Gmail : autorisation insuffisante pour répondre — reconnecte ton compte Gmail (Paramètres > Boîte mail) pour accorder la permission d'envoi.")
    );
    prismaMock.emailImporte.findFirst.mockResolvedValue({
      id: "e1",
      identifiantExterne: "ext-1",
      objet: "Sujet",
      connexion: { userId: "user-1", provider: "gmail" },
    });

    const res = await api("/api/email-ingestion/emails/e1/repondre", {
      method: "POST",
      body: { corps: "Bonjour" },
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("reconnecte ton compte Gmail");
  });
});
