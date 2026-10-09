import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

const prismaMock = vi.hoisted(() => ({
  mobileItem: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  dossier: { findFirst: vi.fn() },
  documentDossier: { create: vi.fn() },
  evenement: { create: vi.fn() },
  mobileAuditLog: { create: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

let currentAuth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = currentAuth;
    next();
  },
}));

const lireFichierMobileMock = vi.hoisted(() => vi.fn());
const supprimerFichierMobileMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/mobileSync/stockageMobile", () => ({
  lireFichierMobile: lireFichierMobileMock,
  supprimerFichierMobile: supprimerFichierMobileMock,
  cheminFichierMobile: vi.fn(),
}));

const enregistrerFichierMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/stockageDocuments", () => ({ enregistrerFichier: enregistrerFichierMock }));

const creerCourrierEntrantMock = vi.hoisted(() => vi.fn());
const uploaderPieceCourrierEntrantMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/courriers/courrierService", () => ({
  creerCourrierEntrant: creerCourrierEntrantMock,
  uploaderPieceCourrierEntrant: uploaderPieceCourrierEntrantMock,
}));

let server: Server;
let baseUrl: string;

async function api(path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

function itemDeBase(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    cabinetId: "cabinet-1",
    deviceId: "device-1",
    type: "scan",
    statut: "a_traiter",
    dossierId: null,
    cheminFichier: "fichier.enc",
    device: { id: "device-1", nomDeclare: "Pixel", userId: "user-1" },
    dossier: null,
    marqueurs: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentAuth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
});

beforeAll(async () => {
  const { mobileElementsRouter } = await import("../mobileElements");
  const app = express();
  app.use(express.json());
  app.use(mobileElementsRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

describe("GET /api/mobile/elements", () => {
  it("un avocat/collaborateur ne voit que les éléments de ses propres appareils", async () => {
    prismaMock.mobileItem.findMany.mockResolvedValue([]);
    await api("/api/mobile/elements");
    expect(prismaMock.mobileItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ device: { userId: "user-1" } }) })
    );
  });

  it("le titulaire voit tous les éléments du cabinet (pas de filtre par device.userId)", async () => {
    currentAuth = { userId: "titulaire-1", cabinetId: "cabinet-1", role: "titulaire" };
    prismaMock.mobileItem.findMany.mockResolvedValue([]);
    await api("/api/mobile/elements");
    const appel = prismaMock.mobileItem.findMany.mock.calls[0][0];
    expect(appel.where.device).toBeUndefined();
  });

  it("exclut toujours les éléments statut='recu' (pas encore assemblés)", async () => {
    prismaMock.mobileItem.findMany.mockResolvedValue([]);
    await api("/api/mobile/elements");
    const appel = prismaMock.mobileItem.findMany.mock.calls[0][0];
    expect(appel.where.statut).toEqual({ not: "recu" });
  });
});

describe("accès à un élément (404 si pas le sien et pas titulaire)", () => {
  it("refuse (404) l'accès à l'élément d'un autre utilisateur pour un avocat", async () => {
    prismaMock.mobileItem.findFirst.mockResolvedValue(itemDeBase({ device: { id: "device-2", nomDeclare: "Autre", userId: "user-2" } }));
    const res = await api("/api/mobile/elements/item-1");
    expect(res.status).toBe(404);
  });

  it("autorise le titulaire à accéder à l'élément de n'importe quel utilisateur", async () => {
    currentAuth = { userId: "titulaire-1", cabinetId: "cabinet-1", role: "titulaire" };
    prismaMock.mobileItem.findFirst.mockResolvedValue(itemDeBase({ device: { id: "device-2", nomDeclare: "Autre", userId: "user-2" } }));
    const res = await api("/api/mobile/elements/item-1");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/mobile/elements/:id/document", () => {
  it("refuse (409) si aucun dossier n'est encore rattaché", async () => {
    prismaMock.mobileItem.findFirst.mockResolvedValue(itemDeBase({ dossierId: null }));
    const res = await api("/api/mobile/elements/item-1/document", { method: "POST" });
    expect(res.status).toBe(409);
    expect(enregistrerFichierMock).not.toHaveBeenCalled();
  });

  it("crée un DocumentDossier avec source='mobile' et marque l'élément traité", async () => {
    prismaMock.mobileItem.findFirst.mockResolvedValue(itemDeBase({ dossierId: "dossier-1" }));
    lireFichierMobileMock.mockResolvedValue(Buffer.from("contenu pdf"));
    enregistrerFichierMock.mockResolvedValue({ nomFichier: "x.enc", tailleOctets: 11 });
    prismaMock.documentDossier.create.mockResolvedValue({ id: "doc-1" });
    prismaMock.mobileItem.update.mockResolvedValue({});

    const res = await api("/api/mobile/elements/item-1/document", { method: "POST" });
    expect(res.status).toBe(201);
    expect(prismaMock.documentDossier.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: "mobile", dossierId: "dossier-1" }) })
    );
    expect(prismaMock.mobileItem.update).toHaveBeenCalledWith({ where: { id: "item-1" }, data: { statut: "traite" } });
  });
});

describe("POST /api/mobile/elements/:id/courrier", () => {
  it("rejette (400) sans objet", async () => {
    prismaMock.mobileItem.findFirst.mockResolvedValue(itemDeBase());
    const res = await api("/api/mobile/elements/item-1/courrier", { method: "POST", body: {} });
    expect(res.status).toBe(400);
  });

  it("crée le courrier puis y attache le scan comme pièce jointe", async () => {
    prismaMock.mobileItem.findFirst.mockResolvedValue(itemDeBase());
    creerCourrierEntrantMock.mockResolvedValue({ id: "courrier-1" });
    lireFichierMobileMock.mockResolvedValue(Buffer.from("contenu pdf"));
    uploaderPieceCourrierEntrantMock.mockResolvedValue({});
    prismaMock.mobileItem.update.mockResolvedValue({});

    const res = await api("/api/mobile/elements/item-1/courrier", { method: "POST", body: { objet: "Convocation" } });
    expect(res.status).toBe(201);
    expect(creerCourrierEntrantMock).toHaveBeenCalledWith("cabinet-1", "user-1", expect.objectContaining({ objet: "Convocation" }));
    expect(uploaderPieceCourrierEntrantMock).toHaveBeenCalled();
  });
});

describe("DELETE /api/mobile/elements/:id", () => {
  it("refuse (409) de supprimer un élément pas encore traité", async () => {
    prismaMock.mobileItem.findFirst.mockResolvedValue(itemDeBase({ statut: "a_traiter" }));
    const res = await api("/api/mobile/elements/item-1", { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("supprime le fichier et la ligne quand l'élément est déjà traité", async () => {
    prismaMock.mobileItem.findFirst.mockResolvedValue(itemDeBase({ statut: "traite" }));
    supprimerFichierMobileMock.mockResolvedValue(undefined);
    prismaMock.mobileItem.delete.mockResolvedValue({});

    const res = await api("/api/mobile/elements/item-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(supprimerFichierMobileMock).toHaveBeenCalledWith("device-1", "fichier.enc");
    expect(prismaMock.mobileItem.delete).toHaveBeenCalledWith({ where: { id: "item-1" } });
  });
});
