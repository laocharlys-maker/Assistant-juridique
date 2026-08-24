import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * La configuration des types de delais (referentiel "Appel : 30 jours"...)
 * etait reservee au titulaire (requireAdmin) - meme un avocat ne pouvait
 * pas en creer/modifier/supprimer, encore moins un collaborateur. Demande
 * explicite : tout le monde (avocat comme collaborateur) doit pouvoir
 * configurer les types de delais. Ce fichier verifie que POST/PATCH/DELETE
 * /api/delais-types et GET ?all=1 (types inactifs inclus) fonctionnent
 * desormais pour n'importe quel role authentifie, pas seulement titulaire.
 */

let currentRole = "titulaire";

const prismaMock = vi.hoisted(() => ({
  cabinet: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  delaiType: { findMany: vi.fn(), create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", cabinetId: "cabinet-1", role: currentRole };
    next();
  },
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

beforeEach(() => {
  vi.clearAllMocks();
  currentRole = "titulaire";
  prismaMock.cabinet.findUnique.mockResolvedValue({ modulesDesactives: [] });
  prismaMock.user.findUnique.mockResolvedValue({ modulesDesactives: [] });
});

beforeAll(async () => {
  const { delaisRouter } = await import("../delais");
  const app = express();
  app.use(express.json());
  app.use(delaisRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

const nouveauType = {
  nom: "Appel",
  nombreUnites: 30,
  unite: "jours",
  texteReference: "Art. 123 CPC",
};

describe.each(["titulaire", "avocat", "collaborateur"])("rôle %s", (role) => {
  beforeEach(() => {
    currentRole = role;
  });

  it("peut créer un type de délai", async () => {
    prismaMock.delaiType.create.mockResolvedValue({ id: "type-1", ...nouveauType });
    const res = await api("/api/delais-types", { method: "POST", body: nouveauType });
    expect(res.status).toBe(201);
  });

  it("peut modifier un type de délai", async () => {
    prismaMock.delaiType.findFirst.mockResolvedValue({ id: "type-1", cabinetId: "cabinet-1" });
    prismaMock.delaiType.update.mockResolvedValue({ id: "type-1", ...nouveauType });
    const res = await api("/api/delais-types/type-1", { method: "PATCH", body: { nom: "Appel modifié" } });
    expect(res.status).toBe(200);
  });

  it("peut supprimer un type de délai", async () => {
    prismaMock.delaiType.deleteMany.mockResolvedValue({ count: 1 });
    const res = await api("/api/delais-types/type-1", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  it("voit les types inactifs avec ?all=1", async () => {
    prismaMock.delaiType.findMany.mockResolvedValue([]);
    const res = await api("/api/delais-types?all=1");
    expect(res.status).toBe(200);
    expect(prismaMock.delaiType.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cabinetId: "cabinet-1" } })
    );
  });
});
