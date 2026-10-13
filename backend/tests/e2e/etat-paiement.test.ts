/**
 * Module RH Cabinet, RH-6 - etat de paiement mensuel : generation UNIQUEMENT
 * depuis les fiches VALIDEES, totaux corrects, marquer paye (bloque une
 * fois l'etat valide), validation qui cloture la periode, exports PDF/CSV.
 *
 * Tourne sur une base PostgreSQL de test jetable (voir full-workflow.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : module RH Cabinet - etat de paiement (RH-6)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let ficheAId: string; // sera validee
  let ficheBId: string; // restera en brouillon

  const MOIS = "2026-12";

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("etat-paiement"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-etat-paiement-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "etat-paiement");
    cabinetId = cabinet.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const ficheA = await fetch(`${baseUrl}/api/personnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: titulaireCookie },
      body: JSON.stringify({ nom: "Validee", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2024-01-01", modePaiement: "virement" }),
    });
    ficheAId = (await ficheA.json()).id;

    const ficheB = await fetch(`${baseUrl}/api/personnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: titulaireCookie },
      body: JSON.stringify({ nom: "Brouillon", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2024-01-01" }),
    });
    ficheBId = (await ficheB.json()).id;

    await api(titulaireCookie, `/api/personnel/${ficheAId}/elements-salaire`, {
      method: "POST",
      body: JSON.stringify({ sens: "gain", libelle: "Salaire de base", modeCalcul: "montant_fixe", valeur: 100000, estSalaireBase: true }),
    });

    await api(titulaireCookie, "/api/periodes-paie", { method: "POST", body: JSON.stringify({ mois: MOIS }) });
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  function api(cookie: string, path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
    });
  }

  it("generer l'etat de paiement SANS aucune fiche validee est refuse", async () => {
    const res = await api(titulaireCookie, `/api/periodes-paie/${MOIS}/etat-paiement`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  let etatId: string;
  let ligneAId: string;

  it("une fois ficheA validee (ficheB reste en brouillon), l'etat ne contient QUE ficheA", async () => {
    const periode = await (await api(titulaireCookie, `/api/periodes-paie/${MOIS}`)).json();
    const ficheAPaie = periode.fiches.find((f: { fichePersonnelId: string }) => f.fichePersonnelId === ficheAId);
    await api(titulaireCookie, `/api/fiches-paie/${ficheAPaie.id}/valider`, { method: "POST" });

    const res = await api(titulaireCookie, `/api/periodes-paie/${MOIS}/etat-paiement`, { method: "POST" });
    expect(res.status).toBe(201);
    const etat = await res.json();
    expect(etat.statut).toBe("brouillon");
    expect(etat.lignes.length).toBe(1);
    expect(etat.lignes[0].fichePaie.fichePersonnel.id).toBe(ficheAId);
    expect(etat.totalNet).toBe(100000);
    expect(etat.lignes[0].modePaiement).toBe("virement");
    expect(etat.lignes[0].statutPaiement).toBe("a_payer");

    etatId = etat.id;
    ligneAId = etat.lignes[0].id;
  });

  it("marquer la ligne comme payee enregistre la date et la reference", async () => {
    const res = await api(titulaireCookie, `/api/lignes-paiement/${ligneAId}`, {
      method: "PATCH",
      body: JSON.stringify({ statutPaiement: "paye", datePaiement: "2026-12-28", reference: "VIR-00042" }),
    });
    expect(res.status).toBe(200);
    const ligne = await res.json();
    expect(ligne.statutPaiement).toBe("paye");
    expect(ligne.reference).toBe("VIR-00042");
  });

  it("regenerer apres validation de ficheB inclut desormais les deux fiches, sans perdre le statut deja paye de ficheA", async () => {
    const periode = await (await api(titulaireCookie, `/api/periodes-paie/${MOIS}`)).json();
    const ficheBPaie = periode.fiches.find((f: { fichePersonnelId: string }) => f.fichePersonnelId === ficheBId);
    // ficheB n'a pas d'element de salaire -> net 0, validable tel quel.
    await api(titulaireCookie, `/api/fiches-paie/${ficheBPaie.id}/valider`, { method: "POST" });

    const res = await api(titulaireCookie, `/api/periodes-paie/${MOIS}/etat-paiement`, { method: "POST" });
    const etat = await res.json();
    expect(etat.lignes.length).toBe(2);
    const ligneA = etat.lignes.find((l: { fichePaie: { fichePersonnel: { id: string } } }) => l.fichePaie.fichePersonnel.id === ficheAId);
    expect(ligneA.statutPaiement).toBe("paye"); // jamais reinitialise par la regeneration
  });

  it("valider l'etat cloture la periode de paie et bloque tout marquage de paiement ulterieur", async () => {
    const periode = await (await api(titulaireCookie, `/api/periodes-paie/${MOIS}`)).json();
    const ficheBPaie = periode.fiches.find((f: { fichePersonnelId: string }) => f.fichePersonnelId === ficheBId);
    const etatAvant = await (await api(titulaireCookie, `/api/periodes-paie/${MOIS}/etat-paiement`)).json();
    const ligneB = etatAvant.lignes.find((l: { fichePaie: { fichePersonnelId?: string; fichePersonnel?: { id: string } } }) => l.fichePaieId === ficheBPaie.id);

    const res = await api(titulaireCookie, `/api/etats-paiement/${etatId}/valider`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).statut).toBe("valide");

    const periodeApres = await prisma.periodePaie.findUnique({ where: { cabinetId_mois: { cabinetId, mois: MOIS } } });
    expect(periodeApres?.statut).toBe("cloturee");

    const refuse = await api(titulaireCookie, `/api/lignes-paiement/${ligneB.id}`, {
      method: "PATCH",
      body: JSON.stringify({ statutPaiement: "paye" }),
    });
    expect(refuse.status).toBe(409);

    const regenRefusee = await api(titulaireCookie, `/api/periodes-paie/${MOIS}/etat-paiement`, { method: "POST" });
    expect(regenRefusee.status).toBe(409);
  });

  it("l'export PDF et l'export CSV de l'etat sont telechargeables", async () => {
    const pdf = await api(titulaireCookie, `/api/etats-paiement/${etatId}/export.pdf`);
    expect(pdf.status).toBe(200);
    const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
    expect(pdfBuffer.subarray(0, 4).toString()).toBe("%PDF");

    const csv = await api(titulaireCookie, `/api/etats-paiement/${etatId}/export.csv`);
    expect(csv.status).toBe(200);
    const csvText = await csv.text();
    expect(csvText).toContain("Validee");
    expect(csvText).toContain("Brouillon");
  });
});
