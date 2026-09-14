/**
 * GET /api/factures : les factures payées sont déclassées sous les
 * factures non encore payées (brouillon/envoyée), pour que le titulaire
 * voie toujours en premier ce qui reste à encaisser.
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

describe.skipIf(!pgAvailable)("e2e : GET /api/factures - tri factures payées/non payées", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let collaborateurCookie: string;
  let collaborateurId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("factures"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-factures-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "factures");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const collaborateur = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Collaborateur Facturation",
        email: "collaborateur-facturation-e2e@test.invalid",
        motDePasseHash: "x",
        role: "collaborateur",
        responsableId: titulaireId,
      },
    });
    collaborateurId = collaborateur.id;
    collaborateurCookie = await mintAuthCookie(collaborateur.id, cabinetId, "collaborateur");
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    pg?.stop();
    if (fakeAppData) fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  async function api(cookie: string, urlPath: string, options: RequestInit = {}) {
    return fetch(`${baseUrl}${urlPath}`, {
      ...options,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(options.headers as Record<string, string>) },
    });
  }

  it("les factures payées apparaissent après les factures non payées, quelle que soit leur date de création", async () => {
    // Creee en premier (donc la plus ancienne) mais deja payee : doit quand
    // meme se retrouver derriere les factures non payees, plus recentes.
    const payeeAncienne = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Payé", numero: "FACT-TEST-101", description: "x", montant: 10000, createdBy: titulaireId, statut: "payee" },
    });
    const brouillonRecent = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Brouillon", numero: "FACT-TEST-102", description: "x", montant: 20000, createdBy: titulaireId, statut: "brouillon" },
    });
    const envoyeeRecente = await prisma.facture.create({
      data: { cabinetId, clientNom: "Client Envoyée", numero: "FACT-TEST-103", description: "x", montant: 30000, createdBy: titulaireId, statut: "envoyee" },
    });

    const res = await api(titulaireCookie, "/api/factures");
    expect(res.status).toBe(200);
    const factures = await res.json();
    const ids = factures.map((f: { id: string }) => f.id);

    const indexPayee = ids.indexOf(payeeAncienne.id);
    const indexBrouillon = ids.indexOf(brouillonRecent.id);
    const indexEnvoyee = ids.indexOf(envoyeeRecente.id);

    expect(indexPayee).toBeGreaterThan(indexBrouillon);
    expect(indexPayee).toBeGreaterThan(indexEnvoyee);
    // A l'interieur du groupe "non payees", l'ordre par date de creation
    // (le plus recent en premier) reste inchange : la plus recente en tete.
    expect(indexEnvoyee).toBeLessThan(indexBrouillon);
  });

  it("genere un numero de facture qui ne collisionne jamais, meme apres suppression d'une facture (ex: fusion)", async () => {
    // Bug reel constate en conditions d'utilisation : PrismaClientKnownRequestError
    // "Unique constraint failed on (cabinet_id, numero)". Cause : genererNumero
    // se basait sur un simple COMPTE de factures existantes - la suppression
    // d'une facture (POST .../fusionner-avec supprime la facture absorbee)
    // decale ce compte et peut recalculer un numero deja pris par une
    // facture plus recente. Desormais base sur le plus grand SUFFIXE
    // numerique deja utilise, jamais sur un compte de lignes.
    const creer = async (clientNom: string) => {
      const res = await api(titulaireCookie, "/api/factures", {
        method: "POST",
        body: JSON.stringify({ clientNom, description: "x", montant: 1000 }),
      });
      expect(res.status).toBe(201);
      return res.json();
    };

    const f1 = await creer("Client Numero 1");
    const f2 = await creer("Client Numero 2");
    const f3 = await creer("Client Numero 3");

    // Simule exactement ce que fait "Fusionner" : suppression de la facture
    // "au milieu" (f2), les autres (f1, f3) restent en base.
    await prisma.facture.delete({ where: { id: f2.id } });

    const f4 = await creer("Client Numero 4");

    // Le nouveau numero doit rester STRICTEMENT superieur au plus grand
    // numero existant (f3) - jamais une reutilisation qui collisionnerait.
    const suffixe = (numero: string) => Number(numero.split("-").pop());
    expect(suffixe(f4.numero)).toBeGreaterThan(suffixe(f3.numero));
    expect(f4.numero).not.toBe(f1.numero);
    expect(f4.numero).not.toBe(f3.numero);
  });

  // Reversion du 2026-09-14 : Facturation ouverte aux collaborateurs (demande
  // explicite du cabinet - "le patron valide, le collaborateur peut ensuite
  // tout faire sauf supprimer"). Seule la transition vers "envoyee" (que ce
  // soit via POST .../envoyer ou PATCH statut=envoyee) reste reservee a un
  // avocat/titulaire.
  it("un collaborateur peut créer une facture, la lister et voir son PDF", async () => {
    const creation = await api(collaborateurCookie, "/api/factures", {
      method: "POST",
      body: JSON.stringify({ clientNom: "Client Collaborateur", description: "x", montant: 5000 }),
    });
    expect(creation.status).toBe(201);
    const facture = await creation.json();

    const liste = await api(collaborateurCookie, "/api/factures");
    expect(liste.status).toBe(200);
    expect((await liste.json()).some((f: { id: string }) => f.id === facture.id)).toBe(true);

    const pdf = await api(collaborateurCookie, `/api/factures/${facture.id}/pdf`);
    expect(pdf.status).toBe(200);
  });

  it("un collaborateur peut marquer une facture payée, mais pas la valider/émettre (ni via /envoyer, ni via PATCH statut=envoyee)", async () => {
    const creation = await api(collaborateurCookie, "/api/factures", {
      method: "POST",
      body: JSON.stringify({ clientNom: "Client Validation", description: "x", montant: 5000 }),
    });
    const facture = await creation.json();

    const viaEnvoyer = await api(collaborateurCookie, `/api/factures/${facture.id}/envoyer`, {
      method: "POST",
      body: JSON.stringify({ email: "client@test.invalid" }),
    });
    expect(viaEnvoyer.status).toBe(403);

    const viaPatch = await api(collaborateurCookie, `/api/factures/${facture.id}`, {
      method: "PATCH",
      body: JSON.stringify({ statut: "envoyee" }),
    });
    expect(viaPatch.status).toBe(403);

    const marquerPayee = await api(collaborateurCookie, `/api/factures/${facture.id}`, {
      method: "PATCH",
      body: JSON.stringify({ statut: "payee" }),
    });
    expect(marquerPayee.status).toBe(200);
    expect((await marquerPayee.json()).statut).toBe("payee");
  });

  it("un avocat/titulaire peut toujours valider/émettre une facture normalement", async () => {
    const creation = await api(titulaireCookie, "/api/factures", {
      method: "POST",
      body: JSON.stringify({ clientNom: "Client Titulaire", description: "x", montant: 5000 }),
    });
    const facture = await creation.json();

    const res = await api(titulaireCookie, `/api/factures/${facture.id}`, {
      method: "PATCH",
      body: JSON.stringify({ statut: "envoyee" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).statut).toBe("envoyee");
  });
});
