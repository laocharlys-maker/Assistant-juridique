import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * "Mot de passe oublié" self-service (routes/auth.ts) : demande d'un code à
 * 6 chiffres envoyé par email, puis réinitialisation avec ce code. Seules
 * ces deux routes sont testées ici (login/premier-lancement/logout/me sont
 * inchangées) - Prisma, bcrypt et l'envoi d'email sont mockés.
 */

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

const sendEmailMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/mailer", () => ({ sendEmail: sendEmailMock }));

const resolveCabinetEmailIdentiteMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/cabinetContact", () => ({
  resolveCabinetEmailIdentite: resolveCabinetEmailIdentiteMock,
}));

vi.mock("../../middleware/rateLimit", () => ({
  loginLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// auth.ts importe aussi config/env.ts directement (cookie `secure`) - meme
// raison de mock que services/auth.ts ci-dessous (DATABASE_URL absent en
// test unitaire pur).
vi.mock("../../config/env", () => ({ env: { NODE_ENV: "test" } }));

// Mock complet (pas d'importActual) : services/auth.ts importe config/env.ts,
// qui exige DATABASE_URL - absent en environnement de test unitaire pur
// (ce projet calcule cette variable au demarrage reel, voir
// bootstrapPortableDatabase.ts). Seule hashPassword est exercee par les deux
// routes testees ici (verifyPassword/signAuthToken appartiennent au login,
// hors scope de ce fichier).
vi.mock("../../services/auth", () => ({
  hashPassword: vi.fn(async (plain: string) => `hashed:${plain}`),
  verifyPassword: vi.fn(),
  signAuthToken: vi.fn(),
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
  resolveCabinetEmailIdentiteMock.mockResolvedValue({ cabinetNom: "Cabinet Test", replyToEmail: null });
  sendEmailMock.mockResolvedValue({ ok: true, messageId: "<abc@relay.brevo.com>" });
});

beforeAll(async () => {
  const { authRouter } = await import("../auth");
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

function userBase(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "avocat@cabinet-test.fr",
    cabinetId: "cabinet-1",
    actif: true,
    resetCodeHash: null as string | null,
    resetCodeExpiresAt: null as Date | null,
    ...overrides,
  };
}

describe("POST /api/auth/mot-de-passe-oublie", () => {
  it("génère un code, l'enregistre haché et envoie l'email, pour un compte existant et actif", async () => {
    prismaMock.user.findUnique.mockResolvedValue(userBase());
    prismaMock.user.update.mockResolvedValue({});

    const res = await api("/api/auth/mot-de-passe-oublie", {
      method: "POST",
      body: { email: "avocat@cabinet-test.fr" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    const updateArgs = prismaMock.user.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: "user-1" });
    expect(updateArgs.data.resetCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(updateArgs.data.resetCodeExpiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const mailArgs = sendEmailMock.mock.calls[0][0];
    expect(mailArgs.destinataireEmail).toBe("avocat@cabinet-test.fr");
    expect(mailArgs.text).toMatch(/\d{6}/);
  });

  it("renvoie le même message générique si le compte n'existe pas (pas d'enumeration)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const res = await api("/api/auth/mot-de-passe-oublie", {
      method: "POST",
      body: { email: "inconnu@example.com" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("ne génère rien pour un compte désactivé", async () => {
    prismaMock.user.findUnique.mockResolvedValue(userBase({ actif: false }));

    const res = await api("/api/auth/mot-de-passe-oublie", {
      method: "POST",
      body: { email: "avocat@cabinet-test.fr" },
    });

    expect(res.status).toBe(200);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/reinitialiser-mot-de-passe", () => {
  it("accepte le bon code (haché) et met à jour le mot de passe", async () => {
    const crypto = await import("node:crypto");
    const code = "123456";
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    prismaMock.user.findUnique.mockResolvedValue(
      userBase({ resetCodeHash: hash, resetCodeExpiresAt: new Date(Date.now() + 60_000) })
    );
    prismaMock.user.update.mockResolvedValue({});

    const res = await api("/api/auth/reinitialiser-mot-de-passe", {
      method: "POST",
      body: { email: "avocat@cabinet-test.fr", code, nouveauMotDePasse: "nouveauMotDePasse123" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const updateArgs = prismaMock.user.update.mock.calls[0][0];
    expect(updateArgs.data.motDePasseHash).toBe("hashed:nouveauMotDePasse123");
    expect(updateArgs.data.resetCodeHash).toBeNull();
    expect(updateArgs.data.resetCodeExpiresAt).toBeNull();
  });

  it("rejette un code erroné sans mettre à jour le mot de passe", async () => {
    const crypto = await import("node:crypto");
    const hash = crypto.createHash("sha256").update("123456").digest("hex");
    prismaMock.user.findUnique.mockResolvedValue(
      userBase({ resetCodeHash: hash, resetCodeExpiresAt: new Date(Date.now() + 60_000) })
    );

    const res = await api("/api/auth/reinitialiser-mot-de-passe", {
      method: "POST",
      body: { email: "avocat@cabinet-test.fr", code: "000000", nouveauMotDePasse: "nouveauMotDePasse123" },
    });

    expect(res.status).toBe(400);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("rejette un code expiré", async () => {
    const crypto = await import("node:crypto");
    const code = "123456";
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    prismaMock.user.findUnique.mockResolvedValue(
      userBase({ resetCodeHash: hash, resetCodeExpiresAt: new Date(Date.now() - 1000) })
    );

    const res = await api("/api/auth/reinitialiser-mot-de-passe", {
      method: "POST",
      body: { email: "avocat@cabinet-test.fr", code, nouveauMotDePasse: "nouveauMotDePasse123" },
    });

    expect(res.status).toBe(400);
    expect(prismaMock.user.update).not.toHaveBeenCalled();
  });

  it("rejette si aucune demande n'est en cours (resetCodeHash null)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(userBase());

    const res = await api("/api/auth/reinitialiser-mot-de-passe", {
      method: "POST",
      body: { email: "avocat@cabinet-test.fr", code: "123456", nouveauMotDePasse: "nouveauMotDePasse123" },
    });

    expect(res.status).toBe(400);
  });

  it("rejette un nouveau mot de passe trop court", async () => {
    const res = await api("/api/auth/reinitialiser-mot-de-passe", {
      method: "POST",
      body: { email: "avocat@cabinet-test.fr", code: "123456", nouveauMotDePasse: "court" },
    });

    expect(res.status).toBe(400);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});
