import "express-async-errors";
import { describe, expect, it, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { errorHandler } from "../errorHandler";

/**
 * Reproduit le bug reel constate en conditions d'utilisation : un clic sur
 * "Facturer le temps" faisait planter TOUTE l'application (page blanche
 * ERR_CONNECTION_REFUSED sur 127.0.0.1, y compris pour des fonctionnalites
 * sans rapport) car Express 4 ne transmet jamais automatiquement a next()
 * une erreur levee/rejetee dans un handler async - elle devenait un rejet
 * de promesse NON RATTRAPE au niveau du PROCESS ENTIER (voir index.ts,
 * handleFatalError). Ce test verifie que le trio
 * express-async-errors + route qui explose + errorHandler evite bien ce
 * scenario : la requete recoit un 500, et AUCUN "unhandledRejection" ne
 * remonte au process pendant ce temps.
 */
describe("errorHandler (filet de securite anti-crash)", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function demarrerAppDeTest() {
    const app = express();
    app.get("/plante-sync", () => {
      throw new Error("boom synchrone");
    });
    app.get("/plante-async", async () => {
      throw new Error("boom asynchrone");
    });
    app.get("/plante-promesse-rejetee", async () => {
      await Promise.reject(new Error("boom promesse"));
    });
    app.get("/ok", (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    const port = (server!.address() as { port: number }).port;
    return `http://127.0.0.1:${port}`;
  }

  it("une erreur synchrone dans une route renvoie 500, jamais un crash du process", async () => {
    const baseUrl = await demarrerAppDeTest();
    const unhandled: unknown[] = [];
    const listener = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", listener);
    try {
      const res = await fetch(`${baseUrl}/plante-sync`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeTruthy();
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toHaveLength(0);
  });

  it("une erreur levee dans un handler async renvoie 500, jamais un crash du process", async () => {
    const baseUrl = await demarrerAppDeTest();
    const unhandled: unknown[] = [];
    const listener = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", listener);
    try {
      const res = await fetch(`${baseUrl}/plante-async`);
      expect(res.status).toBe(500);
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toHaveLength(0);
  });

  it("une promesse rejetee (ex: appel reseau sortant qui echoue hors connexion) renvoie 500, jamais un crash", async () => {
    const baseUrl = await demarrerAppDeTest();
    const unhandled: unknown[] = [];
    const listener = (err: unknown) => unhandled.push(err);
    process.on("unhandledRejection", listener);
    try {
      const res = await fetch(`${baseUrl}/plante-promesse-rejetee`);
      expect(res.status).toBe(500);
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(unhandled).toHaveLength(0);
  });

  it("une route qui reussit continue de repondre normalement (200)", async () => {
    const baseUrl = await demarrerAppDeTest();
    const res = await fetch(`${baseUrl}/ok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
