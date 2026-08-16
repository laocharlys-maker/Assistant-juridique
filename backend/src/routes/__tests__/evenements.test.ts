import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * PATCH/DELETE /api/evenements/:id : le garde-fou "source !== manuel" a été
 * étendu à "source === email" (événement créé depuis la confirmation d'un
 * email, "Boîte de réception") - contrairement à role_audience/delai_calcule,
 * aucun job ne resynchronise un événement "email" depuis son origine après
 * coup, donc rien ne peut le faire diverger silencieusement d'une source qui
 * continuerait d'exister. role_audience et delai_calcule doivent, eux,
 * rester bloqués (régénérés par evenementSync.ts).
 */

const prismaMock = vi.hoisted(() => ({
  evenement: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  evenementAssigne: { deleteMany: vi.fn(), createMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
    next();
  },
}));

const enqueuerSyncEvenementMock = vi.hoisted(() => vi.fn());
const enqueuerSuppressionEvenementMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/calendrierSync/syncQueue", () => ({
  enqueuerSyncEvenement: enqueuerSyncEvenementMock,
  enqueuerSuppressionEvenement: enqueuerSuppressionEvenementMock,
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
  prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof prismaMock) => unknown) => fn(prismaMock));
});

beforeAll(async () => {
  const { evenementsRouter } = await import("../evenements");
  const app = express();
  app.use(express.json());
  app.use(evenementsRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

function evenement(source: string) {
  return { id: "ev-1", cabinetId: "cabinet-1", source, titre: "Titre" };
}

describe("PATCH /api/evenements/:id", () => {
  it("autorise la modification d'un événement source=email (comme manuel)", async () => {
    prismaMock.evenement.findFirst.mockResolvedValue(evenement("email"));
    prismaMock.evenement.update.mockResolvedValue({ ...evenement("email"), titre: "Nouveau titre" });

    const res = await api("/api/evenements/ev-1", { method: "PATCH", body: { titre: "Nouveau titre" } });

    expect(res.status).toBe(200);
    expect(prismaMock.evenement.update).toHaveBeenCalled();
  });

  it("autorise toujours la modification d'un événement source=manuel", async () => {
    prismaMock.evenement.findFirst.mockResolvedValue(evenement("manuel"));
    prismaMock.evenement.update.mockResolvedValue(evenement("manuel"));

    const res = await api("/api/evenements/ev-1", { method: "PATCH", body: { titre: "X" } });

    expect(res.status).toBe(200);
  });

  it("refuse toujours la modification d'un événement source=role_audience (409)", async () => {
    prismaMock.evenement.findFirst.mockResolvedValue(evenement("role_audience"));

    const res = await api("/api/evenements/ev-1", { method: "PATCH", body: { titre: "X" } });

    expect(res.status).toBe(409);
    expect(prismaMock.evenement.update).not.toHaveBeenCalled();
  });

  it("refuse toujours la modification d'un événement source=delai_calcule (409)", async () => {
    prismaMock.evenement.findFirst.mockResolvedValue(evenement("delai_calcule"));

    const res = await api("/api/evenements/ev-1", { method: "PATCH", body: { titre: "X" } });

    expect(res.status).toBe(409);
    expect(prismaMock.evenement.update).not.toHaveBeenCalled();
  });

  it("renvoie 404 si l'événement n'appartient pas au cabinet (ou n'existe pas)", async () => {
    prismaMock.evenement.findFirst.mockResolvedValue(null);
    const res = await api("/api/evenements/ev-1", { method: "PATCH", body: { titre: "X" } });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/evenements/:id", () => {
  it("autorise la suppression d'un événement source=email (comme manuel)", async () => {
    prismaMock.evenement.findFirst.mockResolvedValue(evenement("email"));
    prismaMock.evenement.delete.mockResolvedValue(evenement("email"));

    const res = await api("/api/evenements/ev-1", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(prismaMock.evenement.delete).toHaveBeenCalledWith({ where: { id: "ev-1" } });
  });

  it("refuse toujours la suppression d'un événement source=role_audience (409)", async () => {
    prismaMock.evenement.findFirst.mockResolvedValue(evenement("role_audience"));

    const res = await api("/api/evenements/ev-1", { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(prismaMock.evenement.delete).not.toHaveBeenCalled();
  });

  it("refuse toujours la suppression d'un événement source=delai_calcule (409)", async () => {
    prismaMock.evenement.findFirst.mockResolvedValue(evenement("delai_calcule"));

    const res = await api("/api/evenements/ev-1", { method: "DELETE" });

    expect(res.status).toBe(409);
    expect(prismaMock.evenement.delete).not.toHaveBeenCalled();
  });
});
