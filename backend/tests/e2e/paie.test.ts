/**
 * Module RH Cabinet, RH-5 - paie : elements de salaire (montant fixe,
 * pourcentage sur salaire_base, pourcentage sur brut), ouverture de
 * periode, ajustements mensuels (avec refus si net negatif), validation
 * (figee, numero attribue, PDF genere), annulation (nouvelle version),
 * et permissions (un employe ne voit que ses propres fiches VALIDEES).
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

describe.skipIf(!pgAvailable)("e2e : module RH Cabinet - paie (RH-5)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let empUserId: string;
  let empCookie: string;
  let ficheEmpId: string;
  let autreFicheId: string;

  const MOIS = "2026-11";

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("paie"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-paie-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "paie");
    cabinetId = cabinet.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const emp = await prisma.user.create({
      data: { cabinetId, nom: "Employe Paie", email: "emp-e2e-paie@test.invalid", motDePasseHash: "x", role: "collaborateur" },
    });
    empUserId = emp.id;
    empCookie = await mintAuthCookie(empUserId, cabinetId, "collaborateur");

    const ficheRes = await fetch(`${baseUrl}/api/personnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: titulaireCookie },
      body: JSON.stringify({ nom: "Employe Paie", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2024-01-01", userId: empUserId }),
    });
    ficheEmpId = (await ficheRes.json()).id;

    const autreRes = await fetch(`${baseUrl}/api/personnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: titulaireCookie },
      body: JSON.stringify({ nom: "Autre Employe", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2024-01-01" }),
    });
    autreFicheId = (await autreRes.json()).id;
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

  it("un collaborateur ne peut pas ajouter d'element de salaire (reserve au titulaire)", async () => {
    const res = await api(empCookie, `/api/personnel/${ficheEmpId}/elements-salaire`, {
      method: "POST",
      body: JSON.stringify({ sens: "gain", libelle: "Salaire de base", modeCalcul: "montant_fixe", valeur: 150000, estSalaireBase: true }),
    });
    expect(res.status).toBe(403);
  });

  it("le titulaire configure le salaire : base fixe + prime en pourcentage du salaire de base + retenue en pourcentage du brut", async () => {
    const base = await api(titulaireCookie, `/api/personnel/${ficheEmpId}/elements-salaire`, {
      method: "POST",
      body: JSON.stringify({ sens: "gain", libelle: "Salaire de base", modeCalcul: "montant_fixe", valeur: 150000, estSalaireBase: true }),
    });
    expect(base.status).toBe(201);

    const prime = await api(titulaireCookie, `/api/personnel/${ficheEmpId}/elements-salaire`, {
      method: "POST",
      body: JSON.stringify({ sens: "gain", libelle: "Prime d'ancienneté", modeCalcul: "pourcentage", valeur: 10, baseCalcul: "salaire_base" }),
    });
    expect(prime.status).toBe(201); // 10% de 150000 = 15000

    const retenue = await api(titulaireCookie, `/api/personnel/${ficheEmpId}/elements-salaire`, {
      method: "POST",
      body: JSON.stringify({ sens: "retenue", libelle: "Cotisation", modeCalcul: "pourcentage", valeur: 5, baseCalcul: "brut" }),
    });
    expect(retenue.status).toBe(201); // 5% de (150000+15000=165000) = 8250
  });

  it("ouvrir la periode genere un brouillon par employe actif avec le calcul attendu", async () => {
    const res = await api(titulaireCookie, "/api/periodes-paie", { method: "POST", body: JSON.stringify({ mois: MOIS }) });
    expect(res.status).toBe(201);
    const periode = await res.json();
    expect(periode.fiches.length).toBe(2); // ficheEmp + autreFiche

    const ficheCalculee = periode.fiches.find((f: { fichePersonnelId: string }) => f.fichePersonnelId === ficheEmpId);
    expect(ficheCalculee.brut).toBe(165000); // 150000 + 15000
    expect(ficheCalculee.totalRetenues).toBe(8250); // 5% de 165000
    expect(ficheCalculee.net).toBe(156750);
    expect(ficheCalculee.statut).toBe("brouillon");

    const ficheAutre = periode.fiches.find((f: { fichePersonnelId: string }) => f.fichePersonnelId === autreFicheId);
    expect(ficheAutre.brut).toBe(0); // aucun element de salaire configure
  });

  it("un ajustement mensuel (prime exceptionnelle) augmente le net en consequence", async () => {
    const res = await api(titulaireCookie, `/api/periodes-paie/${MOIS}/ajustements`, {
      method: "POST",
      body: JSON.stringify({ fichePersonnelId: ficheEmpId, sens: "gain", libelle: "Prime exceptionnelle", montant: 20000 }),
    });
    expect(res.status).toBe(201);
    const fiche = await res.json();
    expect(fiche.brut).toBe(185000); // 165000 + 20000
  });

  it("un ajustement qui ferait passer le net sous zero est refuse (et n'est pas applique)", async () => {
    const res = await api(titulaireCookie, `/api/periodes-paie/${MOIS}/ajustements`, {
      method: "POST",
      body: JSON.stringify({ fichePersonnelId: ficheEmpId, sens: "retenue", libelle: "Retenue énorme", montant: 10_000_000 }),
    });
    expect(res.status).toBe(400);

    const periode = await (await api(titulaireCookie, `/api/periodes-paie/${MOIS}`)).json();
    const fiche = periode.fiches.find((f: { fichePersonnelId: string }) => f.fichePersonnelId === ficheEmpId);
    // Inchange depuis le test precedent : brut 185000, retenue = 5% de
    // 185000 (la retenue est en pourcentage du BRUT, donc recalculee avec
    // la prime exceptionnelle incluse) = 9250, net = 175750. La retenue
    // enorme refusee n'a pas ete appliquee.
    expect(fiche.net).toBe(175750);
  });

  let fichePaieId: string;

  it("valider la fiche la fige, lui attribue un numero, et bloque tout ajustement ulterieur", async () => {
    const periode = await (await api(titulaireCookie, `/api/periodes-paie/${MOIS}`)).json();
    const fiche = periode.fiches.find((f: { fichePersonnelId: string }) => f.fichePersonnelId === ficheEmpId);
    fichePaieId = fiche.id;

    const res = await api(titulaireCookie, `/api/fiches-paie/${fichePaieId}/valider`, { method: "POST" });
    expect(res.status).toBe(200);
    const validee = await res.json();
    expect(validee.statut).toBe("validee");
    expect(validee.numero).toMatch(/^PAIE-2026-11-\d{3}$/);

    const ajustementRefuse = await api(titulaireCookie, `/api/periodes-paie/${MOIS}/ajustements`, {
      method: "POST",
      body: JSON.stringify({ fichePersonnelId: ficheEmpId, sens: "gain", libelle: "Trop tard", montant: 1000 }),
    });
    expect(ajustementRefuse.status).toBe(409);
  });

  it("le PDF de la fiche validee est telechargeable", async () => {
    const res = await api(titulaireCookie, `/api/fiches-paie/${fichePaieId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("l'employe concerne voit sa propre fiche validee, mais pas la fiche brouillon d'un autre employe", async () => {
    const mesFiches = await (await api(empCookie, `/api/personnel/${ficheEmpId}/fiches-paie`)).json();
    expect(mesFiches.length).toBe(1);
    expect(mesFiches[0].statut).toBe("validee");

    const autrePeriode = await (await api(titulaireCookie, `/api/periodes-paie/${MOIS}`)).json();
    const ficheAutre = autrePeriode.fiches.find((f: { fichePersonnelId: string }) => f.fichePersonnelId === autreFicheId);

    const refuse = await api(empCookie, `/api/fiches-paie/${ficheAutre.id}`);
    expect(refuse.status).toBe(403);
  });

  it("annuler la fiche validee cree une nouvelle version brouillon, l'ancienne reste archivee 'annulee'", async () => {
    const res = await api(titulaireCookie, `/api/fiches-paie/${fichePaieId}/annuler`, {
      method: "POST",
      body: JSON.stringify({ motif: "Erreur de prime a corriger" }),
    });
    expect(res.status).toBe(201);
    const nouvelle = await res.json();
    expect(nouvelle.statut).toBe("brouillon");
    expect(nouvelle.version).toBe(2);

    const ancienne = await prisma.fichePaie.findUnique({ where: { id: fichePaieId } });
    expect(ancienne?.statut).toBe("annulee");

    // L'employe ne voit plus que 0 fiche VALIDEE (l'ancienne est annulee,
    // la nouvelle est encore brouillon) - jamais d'acces a un brouillon.
    const mesFichesApres = await (await api(empCookie, `/api/personnel/${ficheEmpId}/fiches-paie`)).json();
    expect(mesFichesApres.length).toBe(0);
  });
});
