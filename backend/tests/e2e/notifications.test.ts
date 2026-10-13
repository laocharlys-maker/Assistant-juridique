/**
 * Centre de notifications internes : auteur visible par le destinataire
 * (GET /api/notifications, champ creeParNom) et reponse rapide a une
 * notification (POST /api/notifications/:id/repondre) - demande
 * utilisateur du 2026-10-13. Une reponse est une simple nouvelle
 * Notification adressee a l'auteur d'origine, impossible si l'auteur est
 * inconnu (notification generee par un automatisme, creeParId null).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : notifications - auteur visible et reponse rapide", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let titulaireId: string;
  let cabinetId: string;
  let avocatCookie: string;
  let avocatId: string;

  function api(cookie: string, path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
    });
  }

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("notifications"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-notifications-"));
    process.env.APPDATA = fakeAppData;

    process.env.DATABASE_URL = pg.databaseUrl;
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
    process.env.GEMINI_API_KEY = "dummy-test-key";
    process.env.NODE_ENV = "test";
    process.env.PORT = "0";
    delete process.env.DATABASE_MODE;
    process.env.LICENCE_BYPASS = "true";

    const { app } = await import("../../src/app");
    const { prisma: prismaClient } = await import("../../src/lib/prisma");
    prisma = prismaClient;

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    baseUrl = `http://127.0.0.1:${port}`;

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "notifications");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinetId, "titulaire");

    const avocat = await prisma.user.create({
      data: { cabinetId, nom: "Avocat Notif", email: "avocat-e2e-notifications-2@test.invalid", motDePasseHash: "x", role: "avocat" },
    });
    avocatId = avocat.id;
    avocatCookie = await mintAuthCookie(avocat.id, cabinetId, "avocat");
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  it("le destinataire voit le nom de l'auteur de la notification", async () => {
    await prisma.notification.create({
      data: {
        cabinetId,
        destinataireId: avocatId,
        type: "diffusion",
        titre: "Test",
        message: "Un message",
        creeParId: titulaireId,
      },
    });

    const res = await api(avocatCookie, "/api/notifications");
    const liste = await res.json();
    const notif = liste.find((n: { titre: string }) => n.titre === "Test");
    expect(notif.creeParNom).toBe("Avocat Test");
  });

  it("repondre a une notification cree une nouvelle notification vers l'auteur d'origine", async () => {
    const notifOriginale = await prisma.notification.create({
      data: {
        cabinetId,
        destinataireId: avocatId,
        type: "diffusion",
        titre: "A repondre",
        creeParId: titulaireId,
        lienUrl: "/dossier.html?id=xyz",
      },
    });

    const res = await api(avocatCookie, `/api/notifications/${notifOriginale.id}/repondre`, {
      method: "POST",
      body: JSON.stringify({ message: "Merci, c'est note." }),
    });
    expect(res.status).toBe(201);

    const reponse = await prisma.notification.findFirst({ where: { destinataireId: titulaireId, type: "reponse" } });
    expect(reponse).not.toBeNull();
    expect(reponse!.message).toBe("Merci, c'est note.");
    expect(reponse!.titre).toBe("Réponse de Avocat Notif");
    expect(reponse!.creeParId).toBe(avocatId);
    expect(reponse!.lienUrl).toBe("/dossier.html?id=xyz");
  });

  it("repondre a une notification sans auteur connu est refuse (400)", async () => {
    const notifSansAuteur = await prisma.notification.create({
      data: { cabinetId, destinataireId: avocatId, type: "stage_echeance", titre: "Automatique" },
    });

    const res = await api(avocatCookie, `/api/notifications/${notifSansAuteur.id}/repondre`, {
      method: "POST",
      body: JSON.stringify({ message: "test" }),
    });
    expect(res.status).toBe(400);
  });

  it("repondre a la notification d'un autre destinataire est refuse (404)", async () => {
    const notifAutrui = await prisma.notification.create({
      data: { cabinetId, destinataireId: titulaireId, type: "diffusion", titre: "Pas pour toi", creeParId: avocatId },
    });

    const res = await api(avocatCookie, `/api/notifications/${notifAutrui.id}/repondre`, {
      method: "POST",
      body: JSON.stringify({ message: "test" }),
    });
    expect(res.status).toBe(404);
  });

  it("un message vide est refuse (400)", async () => {
    const notif = await prisma.notification.create({
      data: { cabinetId, destinataireId: avocatId, type: "diffusion", titre: "X", creeParId: titulaireId },
    });

    const res = await api(avocatCookie, `/api/notifications/${notif.id}/repondre`, {
      method: "POST",
      body: JSON.stringify({ message: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("supprimer une notification NON lue est refuse (409)", async () => {
    const notif = await prisma.notification.create({
      data: { cabinetId, destinataireId: avocatId, type: "diffusion", titre: "Pas encore lue" },
    });

    const res = await api(avocatCookie, `/api/notifications/${notif.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
  });

  it("supprimer une notification LUE fonctionne", async () => {
    const notif = await prisma.notification.create({
      data: { cabinetId, destinataireId: avocatId, type: "diffusion", titre: "Lue", lu: true, luAt: new Date() },
    });

    const res = await api(avocatCookie, `/api/notifications/${notif.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await prisma.notification.findUnique({ where: { id: notif.id } })).toBeNull();
  });

  it("vider les lues supprime uniquement les notifications deja lues de ce destinataire", async () => {
    await prisma.notification.create({ data: { cabinetId, destinataireId: avocatId, type: "diffusion", titre: "Lue A", lu: true, luAt: new Date() } });
    await prisma.notification.create({ data: { cabinetId, destinataireId: avocatId, type: "diffusion", titre: "Lue B", lu: true, luAt: new Date() } });
    const nonLue = await prisma.notification.create({ data: { cabinetId, destinataireId: avocatId, type: "diffusion", titre: "Non lue" } });

    const res = await api(avocatCookie, "/api/notifications/supprimer-lues", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.supprimees).toBeGreaterThanOrEqual(2);

    const restantes = await prisma.notification.findMany({ where: { destinataireId: avocatId } });
    expect(restantes.every((n) => !n.lu)).toBe(true);
    expect(restantes.some((n) => n.id === nonLue.id)).toBe(true);
  });
});
