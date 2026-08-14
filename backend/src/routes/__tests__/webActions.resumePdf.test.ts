import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * Passerelle resume PDF -> base de jurisprudence (routes/webActions.ts,
 * type_action "resume_pdf") : tests au niveau route, memes principes que
 * src/routes/__tests__/jurisprudenceBase.test.ts (Prisma/embeddings/LLM
 * mockes - jamais de vraie base pgvector ici, voir ce fichier pour le
 * detail de la limitation e2e). Couvre les criteres d'acceptation du lot :
 * case decochee = comportement inchange (rien de stocke), case cochee =
 * stockage + indexation en une seule requete sans etat intermediaire,
 * contenu indexe = texte brut (jamais le resume), nettoyage si l'indexation
 * echoue en cours de route.
 */

const prismaMock = vi.hoisted(() => ({
  cabinet: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  action: { count: vi.fn(), create: vi.fn() },
  dossier: { upsert: vi.fn() },
  jurisprudencePdf: { create: vi.fn(), deleteMany: vi.fn() },
  jurisprudenceChunk: { deleteMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
    next();
  },
}));
vi.mock("../../middleware/roles", () => ({
  requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../middleware/rateLimit", () => ({
  aiActionsLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../services/llm", () => ({
  getLlmProvider: () => ({ redact: vi.fn().mockResolvedValue("stub") }),
}));

const summarizeLongTextMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/resumePdf", () => ({ summarizeLongText: summarizeLongTextMock }));

const extraireTextePdfMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/pdfExtraction", () => ({
  pdfBufferDepuisDataUrl: vi.fn(() => Buffer.from("pdf-fake")),
  extraireTextePdf: extraireTextePdfMock,
}));

vi.mock("../../services/audit", () => ({ logAuditStep: vi.fn() }));

const embedTextMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/embeddings", () => ({
  embedText: embedTextMock,
  toVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
}));

const stockerPdfMock = vi.hoisted(() => vi.fn());
const supprimerPdfMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/jurisprudence/stockagePdf", () => ({
  stockerPdfJurisprudence: stockerPdfMock,
  supprimerPdfJurisprudence: supprimerPdfMock,
  construireLienInterneDocument: (groupeId: string) => `/api/jurisprudence-base/${groupeId}/document`,
}));

const TEXTE_BRUT = "Texte brut extrait du PDF, suffisamment long pour être indexé sans problème.";
const RESUME_LLM = "Résumé généré par le LLM, complètement différent du texte brut ci-dessus.";

let server: Server;
let baseUrl: string;

interface ReponseWeb {
  contenu: string;
  jurisprudenceIndexation?: { ok: boolean; erreur?: string; lien?: string; chunkCount?: number };
}

async function api(body: unknown) {
  const res = await fetch(`${baseUrl}/api/actions/web`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ReponseWeb };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.cabinet.findUnique.mockResolvedValue({ limiteDocumentsCabinetParMois: null });
  prismaMock.user.findUnique.mockResolvedValue({ limiteDocumentsParMois: null });
  prismaMock.action.count.mockResolvedValue(0);
  prismaMock.dossier.upsert.mockResolvedValue({ id: "dossier-1" });
  prismaMock.action.create.mockResolvedValue({ id: "action-1" });
  prismaMock.jurisprudencePdf.create.mockResolvedValue({});
  prismaMock.jurisprudencePdf.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.jurisprudenceChunk.deleteMany.mockResolvedValue({ count: 0 });
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $executeRawUnsafe: vi.fn() })
  );
  extraireTextePdfMock.mockResolvedValue({ ok: true, texte: TEXTE_BRUT });
  summarizeLongTextMock.mockResolvedValue(RESUME_LLM);
  embedTextMock.mockResolvedValue([0.1, 0.2]);
  stockerPdfMock.mockResolvedValue({ nomFichier: "abc-123.enc", tailleOctets: 4242 });
  supprimerPdfMock.mockResolvedValue(undefined);
});

beforeAll(async () => {
  const { webActionsRouter } = await import("../webActions");
  const app = express();
  app.use(express.json());
  app.use(webActionsRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

const bodyBase = { type_action: "resume_pdf", pdfDataUrl: "data:application/pdf;base64,AAAA" };

describe("resume_pdf - case décochée", () => {
  it("ne stocke aucun fichier ni métadonnée, comportement identique à avant ce lot", async () => {
    const { status, body } = await api({ ...bodyBase, contexte: "contexte libre" });

    expect(status).toBe(201);
    expect(body.contenu).toBe(RESUME_LLM);
    expect(body.jurisprudenceIndexation).toBeUndefined();
    expect(stockerPdfMock).not.toHaveBeenCalled();
    expect(prismaMock.jurisprudencePdf.create).not.toHaveBeenCalled();
    expect(embedTextMock).not.toHaveBeenCalled();
  });
});

describe("resume_pdf - case cochée sans référence", () => {
  it("refuse avec une erreur explicite (la référence est requise)", async () => {
    const { status, body } = await api({ ...bodyBase, ajouterJurisprudence: true });

    expect(status).toBe(400);
    expect((body as unknown as { error: string }).error).toContain("référence");
    expect(stockerPdfMock).not.toHaveBeenCalled();
  });
});

describe("resume_pdf - case cochée avec référence", () => {
  it("stocke le PDF et l'indexe en une seule requête, contenu indexé = texte brut (jamais le résumé)", async () => {
    let contenuInsere = "";
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: vi.fn((_sql: string, ...params: unknown[]) => {
          contenuInsere = params[5] as string;
        }),
      })
    );

    const { status, body } = await api({
      ...bodyBase,
      pdfNomOriginal: "decision.pdf",
      ajouterJurisprudence: true,
      jurisprudenceReference: "Arrêt n° 42/2026",
      jurisprudenceJuridiction: "CCJA",
      jurisprudenceDateDecision: "2026-01-15",
    });

    expect(status).toBe(201);
    // Le résumé reste renvoyé normalement à l'avocat.
    expect(body.contenu).toBe(RESUME_LLM);
    // Stockage + indexation effectués.
    expect(stockerPdfMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.jurisprudencePdf.create).toHaveBeenCalledTimes(1);
    expect(embedTextMock).toHaveBeenCalledTimes(1);
    expect(body.jurisprudenceIndexation?.ok).toBe(true);
    expect(body.jurisprudenceIndexation?.lien).toMatch(/^\/api\/jurisprudence-base\/.+\/document$/);
    // Contenu indexé = texte brut extrait, jamais le résumé généré par le LLM.
    expect(contenuInsere).toContain("Texte brut extrait du PDF");
    expect(contenuInsere).not.toContain(RESUME_LLM);
  });

  it("nettoie le fichier stocké et la métadonnée si l'indexation échoue en cours de route (jamais d'état orphelin)", async () => {
    embedTextMock.mockRejectedValue(new Error("quota Gemini épuisé"));

    const { status, body } = await api({
      ...bodyBase,
      ajouterJurisprudence: true,
      jurisprudenceReference: "Arrêt n° 43/2026",
    });

    // Le résumé reste généré et renvoyé malgré l'échec de l'indexation.
    expect(status).toBe(201);
    expect(body.contenu).toBe(RESUME_LLM);
    expect(body.jurisprudenceIndexation?.ok).toBe(false);
    expect(body.jurisprudenceIndexation?.erreur).toBeTruthy();
    // Nettoyage : fichier physique supprimé, aucune métadonnée/chunk orphelin.
    expect(supprimerPdfMock).toHaveBeenCalledWith("abc-123.enc");
    expect(prismaMock.jurisprudencePdf.deleteMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.jurisprudenceChunk.deleteMany).toHaveBeenCalledTimes(1);
  });
});
