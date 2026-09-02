import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { ACTION_MODULE_MAP } from "../webActions";

/**
 * Controle fin par action a l'interieur de "Nouvelle Action" (dashboard de
 * licence AzoMedIA) : verifie EN PLUS de requireModule("nouvelle_action"),
 * jamais a sa place - voir routes/webActions.ts, ACTION_MODULE_MAP.
 *
 * La cartographie elle-meme (unitaire, sans HTTP) prouve que chaque type
 * d'acte pointe vers la bonne cle. Les deux tests HTTP ne couvrent QUE le
 * chemin "bloque" (retour 403 immediat, avant tout appel LLM/Prisma) - le
 * chemin "autorise" est deja couvert par webActions.jurisprudence.test.ts et
 * webActions.resumePdf.test.ts (estModuleDesactive mocke a false, requetes
 * qui aboutissent). Le reexercer ici demanderait de mocker l'integralite du
 * traitement en aval (Tavily, grounding, generation PDF...) pour un gain nul -
 * seul le garde-fou lui-meme est concerne par ce fichier.
 */

describe("ACTION_MODULE_MAP - cartographie type_action -> cle de module", () => {
  it("regroupe les onze actes de redaction sous une seule cle", () => {
    const actesRediger = [
      "notes", "redac", "assignation", "conclusions", "note_plaidoirie",
      "mise_en_demeure", "plainte", "contrat", "notification_date", "requete", "projet_ordonnance",
    ] as const;
    for (const acte of actesRediger) {
      expect(ACTION_MODULE_MAP[acte]).toBe("action_rediger");
    }
  });

  it("distingue recherche juridique / recherche de jurisprudence / resume de jurisprudence / traduction", () => {
    expect(ACTION_MODULE_MAP.recherche_juridique).toBe("action_recherche_juridique");
    expect(ACTION_MODULE_MAP.jurisprudence).toBe("action_recherche_jurisprudence");
    expect(ACTION_MODULE_MAP.resume_pdf).toBe("action_resume_jurisprudence");
    expect(ACTION_MODULE_MAP.traduction).toBe("action_traduction");
  });
});

const estModuleDesactiveMock = vi.hoisted(() => vi.fn());
vi.mock("../../middleware/roles", () => ({
  requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  estModuleDesactive: estModuleDesactiveMock,
}));
vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
    next();
  },
}));
vi.mock("../../middleware/rateLimit", () => ({
  aiActionsLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Espion : preuve que le garde-fou coupe bien AVANT toute resolution de
// fournisseur LLM (donc avant tout cout/appel reseau IA).
const redactMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/llm", () => ({
  getLlmProvider: vi.fn(() => ({ redact: redactMock })),
  getAnthropicProviderForced: vi.fn(() => ({ redact: redactMock })),
}));

const prismaMock = vi.hoisted(() => ({
  cabinet: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  action: { count: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

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
  const { webActionsRouter } = await import("../webActions");
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(webActionsRouter);
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
  prismaMock.cabinet.findUnique.mockResolvedValue({ limiteDocumentsCabinetParMois: null });
  prismaMock.user.findUnique.mockResolvedValue({ limiteDocumentsParMois: null });
});

describe("POST /api/actions/web - garde-fou par action (chemin bloque)", () => {
  it("bloque 'notes' (action_rediger) quand ce module est désactivé, sans jamais appeler le LLM", async () => {
    estModuleDesactiveMock.mockResolvedValue(true);

    const res = await api("/api/actions/web", {
      method: "POST",
      body: {
        type_action: "notes",
        numero_dossier: "DOS-1",
        nom_affaire: "Affaire Test",
        nom_client: "Client Test",
        date_audience: "2026-01-01",
        nom_juridiction: "TPI Cotonou",
        numero_rg: "RG-123",
        objet_litige: "Litige test",
        deroulement_debats: "Débats test",
        decision: "Décision test",
        prochaine_audience: "2026-02-01",
        pieces_prevoir: ["Pièce 1"],
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/n'est pas activée/);
    expect(estModuleDesactiveMock).toHaveBeenCalledWith("cabinet-1", "user-1", "action_rediger");
    expect(redactMock).not.toHaveBeenCalled();
  });

  it("bloque 'recherche_juridique' (action_recherche_juridique) indépendamment de 'action_rediger'", async () => {
    estModuleDesactiveMock.mockResolvedValue(true);

    const res = await api("/api/actions/web", {
      method: "POST",
      body: { type_action: "recherche_juridique", question: "Délai de prescription en matière civile ?" },
    });

    expect(res.status).toBe(403);
    expect(estModuleDesactiveMock).toHaveBeenCalledWith("cabinet-1", "user-1", "action_recherche_juridique");
    expect(redactMock).not.toHaveBeenCalled();
  });

  it("vérifie la bonne clé pour 'traduction' (action_traduction), pas 'action_rediger'", async () => {
    estModuleDesactiveMock.mockResolvedValue(true);

    await api("/api/actions/web", {
      method: "POST",
      body: { type_action: "traduction", sens: "fr_vers_en", texte_source: "Bonjour" },
    });

    expect(estModuleDesactiveMock).toHaveBeenCalledWith("cabinet-1", "user-1", "action_traduction");
  });
});
