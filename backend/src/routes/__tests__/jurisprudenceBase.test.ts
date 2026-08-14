import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * Tests de src/routes/jurisprudenceBase.ts avec Prisma et l'authentification
 * MOCKES (jamais de vraie base Postgres ici) - contrairement au reste du
 * projet (tests/e2e/*, qui tournent sur un vrai cluster Postgres jetable).
 * Raison : ce cluster de test n'a PAS l'extension pgvector (compilation
 * impossible sans Visual Studio Build Tools sur cette machine, meme limite
 * documentee de longue date - voir tests/e2e/helpers/testPostgres.ts, et
 * son schema retire deliberement la colonne "embedding" et l'extension
 * "vector" avant application). Un test e2e classique ne pourrait donc
 * jamais exercer le vrai INSERT (qui reference une colonne "embedding"
 * inexistante dans ce schema de test) - d'ou ce test au niveau route,
 * Prisma/embeddings mockes, HTTP reel (fetch) sur un serveur Express
 * minimal ne montant QUE ce routeur.
 */

const prismaMock = vi.hoisted(() => ({
  jurisprudenceChunk: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  $transaction: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../middleware/roles", () => ({
  requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const embedTextMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/embeddings", () => ({
  embedText: embedTextMock,
  toVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
}));

let server: Server;
let baseUrl: string;

interface ReponsePost {
  ids: string[];
  groupeId: string;
  chunkCount: number;
}
interface ReponsePatch {
  ok: boolean;
  chunksModifies: number;
}

async function api(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  embedTextMock.mockResolvedValue([0.1, 0.2, 0.3]);
  // $transaction (interactive) : execute le callback avec un "tx" factice
  // exposant $executeRawUnsafe - meme comportement observable que le vrai
  // Prisma pour ce que jurisprudenceBase.ts en fait (jamais de vrai
  // rollback ici, hors-sujet pour ces tests de construction de requete).
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $executeRawUnsafe: vi.fn() })
  );
});

beforeAll(async () => {
  const { jurisprudenceBaseRouter } = await import("../jurisprudenceBase");
  const app = express();
  app.use(express.json());
  app.use(jurisprudenceBaseRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

describe("POST /api/jurisprudence-base - contenu court (1 chunk)", () => {
  it("insère un seul chunk, aucun découpage", async () => {
    let sqlCapture = "";
    let paramsCapture: unknown[] = [];
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: vi.fn((sql: string, ...params: unknown[]) => {
          sqlCapture = sql;
          paramsCapture = params;
        }),
      })
    );

    const res = await api("/api/jurisprudence-base", {
      method: "POST",
      body: {
        source: "Cour Suprême",
        reference: "Arrêt n° 1/2026",
        contenu: "Ceci est un contenu court, bien en-deça du seuil de découpage en plusieurs chunks.",
      },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as ReponsePost;
    expect(body.chunkCount).toBe(1);
    expect(embedTextMock).toHaveBeenCalledTimes(1);
    expect(sqlCapture).toContain("INSERT INTO jurisprudence_chunks");
    expect(paramsCapture).toHaveLength(9);
  });
});

describe("POST /api/jurisprudence-base - contenu long (plusieurs chunks)", () => {
  it("découpe en plusieurs chunks, un embedding et un INSERT par chunk", async () => {
    const insertions: unknown[][] = [];
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: vi.fn((_sql: string, ...params: unknown[]) => {
          insertions.push(params);
        }),
      })
    );

    // ~5000 caractères, largement au-dessus du seuil de chunking (1500).
    const paragraphe = "Un paragraphe de décision juridique suffisamment long pour peser dans le découpage. ".repeat(15);
    const contenuLong = Array.from({ length: 6 }, () => paragraphe).join("\n\n");

    const res = await api("/api/jurisprudence-base", {
      method: "POST",
      body: { source: "OHADA", reference: "Arrêt n° 2/2026", contenu: contenuLong },
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as ReponsePost;
    expect(body.chunkCount).toBeGreaterThan(1);
    expect(embedTextMock).toHaveBeenCalledTimes(body.chunkCount);
    expect(insertions).toHaveLength(body.chunkCount);
    // Tous les chunks d'une meme decision partagent le meme groupe_id (index 7).
    const groupeIds = new Set(insertions.map((params) => params[7]));
    expect(groupeIds.size).toBe(1);
    // Aucun chunk n'excède ~1800 caractères (TAILLE_CIBLE_CHUNK * 1.5, voir chunkerTexte.ts).
    for (const params of insertions) {
      expect((params[5] as string).length).toBeLessThanOrEqual(1800);
    }
  });
});

describe("POST /api/jurisprudence-base - absence d'injection SQL", () => {
  it("une valeur contenant une syntaxe SQL malveillante est traitée comme donnée littérale (paramètre lié, jamais interpolée)", async () => {
    let sqlCapture = "";
    let paramsCapture: unknown[] = [];
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: vi.fn((sql: string, ...params: unknown[]) => {
          sqlCapture = sql;
          paramsCapture = params;
        }),
      })
    );

    const payloadMalveillant = "'; DROP TABLE jurisprudence_chunks; --";

    const res = await api("/api/jurisprudence-base", {
      method: "POST",
      body: {
        source: payloadMalveillant,
        reference: "Arrêt n° 3/2026",
        contenu: `Contenu légitime suffisamment long pour passer la validation. ${payloadMalveillant}`,
      },
    });

    expect(res.status).toBe(201);
    // La chaîne SQL elle-même ne contient QUE des placeholders $1..$9,
    // jamais la valeur malveillante recopiée dedans.
    expect(sqlCapture).not.toContain("DROP TABLE");
    expect(sqlCapture).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9::vector, now\(\)\)/);
    // La valeur malveillante est bien presente, mais UNIQUEMENT comme
    // parametre lie (donnee litterale) - jamais executee comme SQL.
    expect(paramsCapture).toContain(payloadMalveillant);
  });
});

describe("PATCH /api/jurisprudence-base/:id - décision multi-chunkée", () => {
  it("met à jour le lien de TOUS les chunks du groupe quand le chunk cible a un groupeId", async () => {
    prismaMock.jurisprudenceChunk.findUnique.mockResolvedValue({ id: "chunk-2", groupeId: "groupe-abc" });
    prismaMock.jurisprudenceChunk.updateMany.mockResolvedValue({ count: 3 });

    const res = await api("/api/jurisprudence-base/chunk-2", {
      method: "PATCH",
      body: { lien: "https://exemple.bj/decision" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ReponsePatch;
    expect(body.chunksModifies).toBe(3);
    expect(prismaMock.jurisprudenceChunk.updateMany).toHaveBeenCalledWith({
      where: { groupeId: "groupe-abc" },
      data: { lien: "https://exemple.bj/decision" },
    });
  });

  it("se replie sur une mise à jour par id seul pour le corpus indexé avant ce lot (groupeId absent)", async () => {
    prismaMock.jurisprudenceChunk.findUnique.mockResolvedValue({ id: "chunk-legacy", groupeId: null });
    prismaMock.jurisprudenceChunk.updateMany.mockResolvedValue({ count: 1 });

    const res = await api("/api/jurisprudence-base/chunk-legacy", {
      method: "PATCH",
      body: { lien: "https://exemple.bj/legacy" },
    });

    expect(res.status).toBe(200);
    expect(prismaMock.jurisprudenceChunk.updateMany).toHaveBeenCalledWith({
      where: { id: "chunk-legacy" },
      data: { lien: "https://exemple.bj/legacy" },
    });
  });

  it("renvoie 404 si le chunk demandé n'existe pas", async () => {
    prismaMock.jurisprudenceChunk.findUnique.mockResolvedValue(null);

    const res = await api("/api/jurisprudence-base/inexistant", {
      method: "PATCH",
      body: { lien: "https://exemple.bj/x" },
    });

    expect(res.status).toBe(404);
    expect(prismaMock.jurisprudenceChunk.updateMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/jurisprudence-base/:id", () => {
  it("supprime le chunk demandé quand la décision n'a qu'un seul chunk (legacy, groupeId absent)", async () => {
    prismaMock.jurisprudenceChunk.findUnique.mockResolvedValue({ id: "chunk-1", groupeId: null });
    prismaMock.jurisprudenceChunk.deleteMany.mockResolvedValue({ count: 1 });

    const res = await api("/api/jurisprudence-base/chunk-1", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunksSupprimes: number };
    expect(body.chunksSupprimes).toBe(1);
    expect(prismaMock.jurisprudenceChunk.deleteMany).toHaveBeenCalledWith({ where: { id: "chunk-1" } });
  });

  it("supprime TOUS les chunks d'une décision multi-chunkée, aucune ligne orpheline (régression Lot 18)", async () => {
    prismaMock.jurisprudenceChunk.findUnique.mockResolvedValue({ id: "chunk-2", groupeId: "groupe-xyz" });
    prismaMock.jurisprudenceChunk.deleteMany.mockResolvedValue({ count: 4 });

    const res = await api("/api/jurisprudence-base/chunk-2", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunksSupprimes: number };
    expect(body.chunksSupprimes).toBe(4);
    expect(prismaMock.jurisprudenceChunk.deleteMany).toHaveBeenCalledWith({ where: { groupeId: "groupe-xyz" } });
    // Jamais un DELETE par id seul quand un groupeId est disponible - sinon
    // les 3 autres chunks du groupe resteraient orphelins.
    expect(prismaMock.jurisprudenceChunk.deleteMany).not.toHaveBeenCalledWith({ where: { id: "chunk-2" } });
  });

  it("répond proprement (aucune suppression) si le chunk demandé n'existe déjà plus", async () => {
    prismaMock.jurisprudenceChunk.findUnique.mockResolvedValue(null);

    const res = await api("/api/jurisprudence-base/inexistant", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunksSupprimes: number };
    expect(body.chunksSupprimes).toBe(0);
    expect(prismaMock.jurisprudenceChunk.deleteMany).not.toHaveBeenCalled();
  });
});
