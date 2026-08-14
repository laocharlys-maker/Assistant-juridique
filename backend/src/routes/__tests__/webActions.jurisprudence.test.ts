import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * type_action "jurisprudence" (routes/webActions.ts) - régression
 * JURIS-1786731229315 : max_tokens explicite (16000) transmis au LLM, et
 * signal visible côté avocat si aucune citation n'a été reconnue par
 * grounding.ts alors que des sources étaient disponibles. Mêmes principes
 * que webActions.resumePdf.test.ts (Prisma/LLM/Tavily mockés, HTTP réel).
 * grounding.ts N'EST PAS mocké (comportement réel exercé) - safe ici car le
 * texte LLM de test ne contient jamais de marqueur "[REF: Source N]"
 * reconnu, donc verifierLien() n'est jamais appelé (aVerifier reste vide).
 */

const prismaMock = vi.hoisted(() => ({
  cabinet: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  action: { count: vi.fn(), create: vi.fn() },
  dossier: { upsert: vi.fn() },
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

const redactMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/llm", () => ({
  getLlmProvider: () => ({ redact: redactMock }),
  getAnthropicProviderForced: () => ({ redact: redactMock }),
}));

const rechercherJurisprudenceTavilyMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/jurisprudence/rechercheTavily", () => ({
  rechercherJurisprudenceTavily: rechercherJurisprudenceTavilyMock,
}));

vi.mock("../../services/rag", () => ({ searchJurisprudence: vi.fn().mockResolvedValue([]) }));
vi.mock("../../services/audit", () => ({ logAuditStep: vi.fn() }));
// grounding.ts (non mocké, comportement réel exercé) appelle verifierLien()
// pour toute citation reconnue - mocké ici pour éviter une vraie requête
// HTTP (lente, non déterministe) dans le test "citation reconnue et
// validée" ci-dessous. Sans effet sur les autres tests de ce fichier
// (0 citation reconnue => verifierLien jamais appelé, voir grounding.ts).
vi.mock("../../services/jurisprudence/verifierLien", () => ({
  verifierLien: vi.fn().mockResolvedValue({ accessible: true, statut: 200, verifieA: Date.now() }),
}));

let server: Server;
let baseUrl: string;

interface ReponseWeb {
  contenu: string;
  sourcesJurisprudence?: unknown[];
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
  rechercherJurisprudenceTavilyMock.mockResolvedValue([
    {
      title: "CCJA, Arrêt n° 1/2024",
      url: "https://juricaf.org/arret-1-2024",
      content: "Résumé de l'arrêt...",
      publishedDate: "2024-01-01",
      categorie: "ohada",
    },
  ]);
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

describe("jurisprudence - max_tokens explicite (régression JURIS-1786731229315)", () => {
  it("transmet maxTokens=16000 à redact(), jamais le défaut implicite de redact()", async () => {
    redactMock.mockResolvedValue("Analyse complète, sans citation particulière.");

    const res = await api({ type_action: "jurisprudence", theme: "Bail commercial" });

    expect(res.status).toBe(201);
    expect(redactMock).toHaveBeenCalledTimes(1);
    expect(redactMock.mock.calls[0][2]).toEqual({ maxTokens: 16000 });
  });
});

describe("jurisprudence - signal visible côté avocat si 0 citation reconnue (régression JURIS-1786731229315)", () => {
  it("ajoute un avertissement visible dans le document quand des sources étaient disponibles mais aucune citation n'est reconnue (format non conforme)", async () => {
    redactMock.mockResolvedValue(
      "La CCJA a jugé que... (Arrêt n° 1/2024) [Source 1]. Ceci confirme la tendance dégagée."
    );

    const { status, body } = await api({ type_action: "jurisprudence", theme: "Bail commercial" });

    expect(status).toBe(201);
    expect(body.contenu).toContain(
      "Aucune citation n'a pu être validée automatiquement pour ce document malgré des sources disponibles"
    );
    // Cohérent avec l'absence de source validée : aucun bloc "Source" à afficher.
    expect(body.sourcesJurisprudence).toBeUndefined();
  });

  it("n'ajoute AUCUN avertissement quand une citation est correctement reconnue et validée (comportement nominal inchangé)", async () => {
    redactMock.mockResolvedValue(
      "La CCJA a jugé que... (Arrêt n° 1/2024) [REF: Source 1]. Ceci confirme la tendance dégagée."
    );

    const { status, body } = await api({ type_action: "jurisprudence", theme: "Bail commercial" });

    expect(status).toBe(201);
    expect(body.contenu).not.toContain("Aucune citation n'a pu être validée automatiquement");
    // Confirme que ce test exerce bien le cas "citation reconnue ET validée"
    // (sourcesValidees non vide), pas un cas accidentel de rejet.
    expect(body.sourcesJurisprudence).toHaveLength(1);
  });

  it("n'ajoute PAS ce nouvel avertissement quand aucune source n'était disponible du tout (rien à sourcer, comportement inchangé)", async () => {
    rechercherJurisprudenceTavilyMock.mockResolvedValue([]);
    redactMock.mockResolvedValue("Analyse générale, sans jurisprudence disponible à citer pour ce thème.");

    const { status, body } = await api({ type_action: "jurisprudence", theme: "Sujet très pointu" });

    expect(status).toBe(201);
    expect(body.contenu).not.toContain("Aucune citation n'a pu être validée automatiquement");
  });
});
