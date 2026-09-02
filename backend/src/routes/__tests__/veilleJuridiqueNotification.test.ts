import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * Notification in-app du dernier digest de veille juridique (EN PLUS de
 * l'email deja envoye, jamais a sa place - voir services/veilleJuridique.ts,
 * inchange). Verifie uniquement ce nouveau routeur : la generation/l'envoi
 * du digest lui-meme est deja couvert ailleurs.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
  action: { findFirst: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
    next();
  },
}));
vi.mock("../../middleware/roles", () => ({
  requireAvocat: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

let server: Server;
let baseUrl: string;

interface ReponseDerniere {
  digest: { dossierId: string; titre: string; createdAt: string; vue: boolean } | null;
}

async function api(path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

beforeAll(async () => {
  const { veilleJuridiqueNotificationRouter } = await import("../veilleJuridiqueNotification");
  const app = express();
  app.use(express.json());
  app.use(veilleJuridiqueNotificationRouter);
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
});

const ACTION_BASE = {
  dossierId: "dossier-1",
  createdAt: new Date("2026-08-31T06:00:00.000Z"),
  dossier: { nomAffaire: "Veille juridique - du 24 août au 28 août 2026" },
};

describe("GET /api/veille-juridique/derniere", () => {
  it("renvoie digest:null si l'utilisateur a désactivé la réception de la veille", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ recoitVeille: false, veilleDerniereVue: null });

    const res = await api("/api/veille-juridique/derniere");
    const body = await res.json();

    expect(body).toEqual({ digest: null });
    expect(prismaMock.action.findFirst).not.toHaveBeenCalled();
  });

  it("renvoie digest:null si aucun digest n'a jamais été généré", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ recoitVeille: true, veilleDerniereVue: null });
    prismaMock.action.findFirst.mockResolvedValue(null);

    const res = await api("/api/veille-juridique/derniere");
    const body = await res.json();

    expect(body).toEqual({ digest: null });
  });

  it("vue=false quand le digest n'a jamais été consulté", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ recoitVeille: true, veilleDerniereVue: null });
    prismaMock.action.findFirst.mockResolvedValue(ACTION_BASE);

    const res = await api("/api/veille-juridique/derniere");
    const body = (await res.json()) as ReponseDerniere;

    expect(body.digest!.vue).toBe(false);
    expect(body.digest!.dossierId).toBe("dossier-1");
  });

  it("vue=true quand veilleDerniereVue est postérieur ou égal au digest", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      recoitVeille: true,
      veilleDerniereVue: new Date("2026-08-31T06:00:00.000Z"),
    });
    prismaMock.action.findFirst.mockResolvedValue(ACTION_BASE);

    const res = await api("/api/veille-juridique/derniere");
    const body = (await res.json()) as ReponseDerniere;

    expect(body.digest!.vue).toBe(true);
  });

  it("vue=false quand un nouveau digest est arrivé après la dernière consultation", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      recoitVeille: true,
      veilleDerniereVue: new Date("2026-08-24T06:00:00.000Z"), // semaine precedente
    });
    prismaMock.action.findFirst.mockResolvedValue(ACTION_BASE); // 2026-08-31

    const res = await api("/api/veille-juridique/derniere");
    const body = (await res.json()) as ReponseDerniere;

    expect(body.digest!.vue).toBe(false);
  });
});

describe("POST /api/veille-juridique/vue", () => {
  it("enregistre la date du dernier digest comme vue", async () => {
    prismaMock.action.findFirst.mockResolvedValue({ createdAt: new Date("2026-08-31T06:00:00.000Z") });

    const res = await api("/api/veille-juridique/vue", { method: "POST" });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { veilleDerniereVue: new Date("2026-08-31T06:00:00.000Z") },
    });
  });

  it("ne fait rien si aucun digest n'existe (jamais d'erreur)", async () => {
    prismaMock.action.findFirst.mockResolvedValue(null);

    const res = await api("/api/veille-juridique/vue", { method: "POST" });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });
});
