import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * Controle fin "action_transcription" (dashboard de licence AzoMedIA) sur
 * l'upload de piece (routes/documentsDossier.ts) : ne doit s'appliquer QUE
 * quand la requete porte `viaTranscription: true` (envoye uniquement par
 * l'ecran dedie "Transcrire un document" de Nouvelle Action, voir
 * public/nouvelle-action.html) - un depot de piece ordinaire depuis l'onglet
 * Pieces du dossier (dossier.html, qui n'envoie jamais ce champ) ne doit
 * JAMAIS etre bloque par ce module, meme desactive.
 */

const estModuleDesactiveMock = vi.hoisted(() => vi.fn());
vi.mock("../../middleware/roles", () => ({ estModuleDesactive: estModuleDesactiveMock }));

// documentsDossier.ts importe config/env.ts directement (DOCUMENTS_TAILLE_MAX_MO) -
// meme raison de mock que pour auth.ts (DATABASE_URL absent en test unitaire pur).
vi.mock("../../config/env", () => ({ env: { DOCUMENTS_TAILLE_MAX_MO: 20 } }));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
    next();
  },
}));

const prismaMock = vi.hoisted(() => ({
  dossier: { findFirst: vi.fn() },
  documentDossier: { create: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

const enregistrerFichierMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/stockageDocuments", () => ({
  enregistrerFichier: enregistrerFichierMock,
  lireFichier: vi.fn(),
  supprimerFichier: vi.fn(),
}));

const enqueuerTraitementOcrMock = vi.hoisted(() => vi.fn());
vi.mock("../../jobs/traitementOcr", () => ({ enqueuerTraitementOcr: enqueuerTraitementOcrMock }));

let server: Server;
let baseUrl: string;

async function api(path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

beforeAll(async () => {
  const { documentsDossierRouter } = await import("../documentsDossier");
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(documentsDossierRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.dossier.findFirst.mockResolvedValue({ id: "dossier-1", cabinetId: "cabinet-1" });
  enqueuerTraitementOcrMock.mockResolvedValue(undefined);
});

const FICHIER_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQK";

describe("POST /api/dossiers/:dossierId/documents - viaTranscription", () => {
  it("bloque l'upload quand viaTranscription=true et action_transcription est désactivé", async () => {
    estModuleDesactiveMock.mockResolvedValue(true);

    const res = await api("/api/dossiers/dossier-1/documents", {
      method: "POST",
      body: { nom: "scan.pdf", fichierDataUrl: FICHIER_DATA_URL, viaTranscription: true },
    });

    expect(res.status).toBe(403);
    expect(estModuleDesactiveMock).toHaveBeenCalledWith("cabinet-1", "user-1", "action_transcription");
    expect(prismaMock.documentDossier.create).not.toHaveBeenCalled();
  });

  it("n'appelle jamais estModuleDesactive pour un upload ordinaire (sans viaTranscription)", async () => {
    enregistrerFichierMock.mockResolvedValue({ nomFichier: "f1", tailleOctets: 10 });
    prismaMock.documentDossier.create.mockResolvedValue({ id: "doc-1", nomOriginal: "scan.pdf" });

    const res = await api("/api/dossiers/dossier-1/documents", {
      method: "POST",
      body: { nom: "scan.pdf", fichierDataUrl: FICHIER_DATA_URL },
    });

    expect(res.status).toBe(201);
    expect(estModuleDesactiveMock).not.toHaveBeenCalled();
  });

  it("laisse passer l'upload via l'écran Transcrire quand action_transcription est actif", async () => {
    estModuleDesactiveMock.mockResolvedValue(false);
    enregistrerFichierMock.mockResolvedValue({ nomFichier: "f1", tailleOctets: 10 });
    prismaMock.documentDossier.create.mockResolvedValue({ id: "doc-1", nomOriginal: "scan.pdf" });

    const res = await api("/api/dossiers/dossier-1/documents", {
      method: "POST",
      body: { nom: "scan.pdf", fichierDataUrl: FICHIER_DATA_URL, viaTranscription: true },
    });

    expect(res.status).toBe(201);
    expect(estModuleDesactiveMock).toHaveBeenCalledWith("cabinet-1", "user-1", "action_transcription");
  });
});
