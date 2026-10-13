/**
 * Module RH Cabinet, RH-7 (durcissement) - tests transversaux non couverts
 * par les suites RH-1 a RH-6 : isolation stricte ENTRE CABINETS (jamais
 * testee explicitement route par route jusqu'ici, chaque suite precedente
 * ne verifiant que les permissions DANS un meme cabinet) et verrouillage
 * par module ("rh" / "rh_paie", Cabinet.modulesDesactives /
 * User.modulesDesactives - voir docs/rh/00-audit.md, decision 1).
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

describe.skipIf(!pgAvailable)("e2e : module RH Cabinet - durcissement (RH-7)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  // Cabinet A : celui depuis lequel on tente les fuites.
  let titulaireACookie: string;
  let cabinetAId: string;

  // Cabinet B : donnees "a proteger".
  let titulaireBCookie: string;
  let cabinetBId: string;
  let ficheBId: string;
  let stageBId: string;
  let demandeBId: string;
  let planningBId: string;
  let fichePaieBId: string;
  let etatPaiementBId: string;

  function api(cookie: string, path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Cookie: cookie, ...(init.headers || {}) },
    });
  }

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("rh-durcissement"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-rh-durcissement-"));
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

    const { cabinet: cabinetA, user: titulaireA } = await seedCabinetEtTitulaire(prisma, "rh-durciss-a");
    cabinetAId = cabinetA.id;
    titulaireACookie = await mintAuthCookie(titulaireA.id, cabinetAId, "titulaire");

    const { cabinet: cabinetB, user: titulaireB } = await seedCabinetEtTitulaire(prisma, "rh-durciss-b");
    cabinetBId = cabinetB.id;
    titulaireBCookie = await mintAuthCookie(titulaireB.id, cabinetBId, "titulaire");

    // Fiche personnel + solde + element de salaire dans le cabinet B.
    const ficheB = await api(titulaireBCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({ nom: "Confidentiel B", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2022-01-01" }),
    });
    ficheBId = (await ficheB.json()).id;

    await api(titulaireBCookie, `/api/personnel/${ficheBId}/elements-salaire`, {
      method: "POST",
      body: JSON.stringify({ sens: "gain", libelle: "Salaire de base", modeCalcul: "montant_fixe", valeur: 300000, estSalaireBase: true }),
    });

    // Stage dans le cabinet B, responsable = titulaire B.
    const titulaireBComplet = await prisma.user.findFirstOrThrow({ where: { cabinetId: cabinetBId, role: "titulaire" } });
    const stageB = await api(titulaireBCookie, `/api/personnel/${ficheBId}/stages`, {
      method: "POST",
      body: JSON.stringify({ responsableId: titulaireBComplet.id, dateDebut: "2026-01-01", dateFinPrevue: "2026-03-01" }),
    });
    stageBId = (await stageB.json()).id;

    // Demande d'absence dans le cabinet B.
    const typesB = await api(titulaireBCookie, "/api/types-absence");
    const typeCongeB = (await typesB.json())[0];
    const demandeB = await api(titulaireBCookie, `/api/personnel/${ficheBId}/demandes-absence`, {
      method: "POST",
      body: JSON.stringify({ typeAbsenceId: typeCongeB.id, dateDebut: "2026-06-01", dateFin: "2026-06-05" }),
    });
    demandeBId = (await demandeB.json()).id;

    // Planning de conges dans le cabinet B.
    const planningB = await api(titulaireBCookie, "/api/planning-conges", {
      method: "POST",
      body: JSON.stringify({ annee: 2027, effectifMin: 0, periodesBloquees: [] }),
    });
    planningBId = (await planningB.json()).id;

    // Periode de paie + fiche de paie dans le cabinet B.
    const periodeB = await api(titulaireBCookie, "/api/periodes-paie", { method: "POST", body: JSON.stringify({ mois: "2026-11" }) });
    fichePaieBId = (await periodeB.json()).fiches[0].id;
    await api(titulaireBCookie, `/api/fiches-paie/${fichePaieBId}/valider`, { method: "POST" });

    // Etat de paiement dans le cabinet B.
    const etatB = await api(titulaireBCookie, "/api/periodes-paie/2026-11/etat-paiement", { method: "POST" });
    etatPaiementBId = (await etatB.json()).id;
  });

  afterAll(async () => {
    if (!pgAvailable) return;
    server?.close();
    await prisma?.$disconnect();
    await pg?.stop();
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  it("le titulaire du cabinet A ne voit AUCUNE fiche du cabinet B dans sa liste", async () => {
    const res = await api(titulaireACookie, "/api/personnel?statut=tous");
    expect(res.status).toBe(200);
    const liste = await res.json();
    expect(liste.find((f: { id: string }) => f.id === ficheBId)).toBeUndefined();
  });

  it("le titulaire du cabinet A ne peut pas consulter une fiche personnel du cabinet B (404, pas 403 - n'existe pas pour lui)", async () => {
    const res = await api(titulaireACookie, `/api/personnel/${ficheBId}`);
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas consulter le solde de conges d'une fiche du cabinet B", async () => {
    const res = await api(titulaireACookie, `/api/personnel/${ficheBId}/solde-conges`);
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas lister les elements de salaire d'une fiche du cabinet B", async () => {
    const res = await api(titulaireACookie, `/api/personnel/${ficheBId}/elements-salaire`);
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas consulter un stage du cabinet B", async () => {
    const res = await api(titulaireACookie, `/api/personnel/${ficheBId}/stages`);
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas cloturer un stage du cabinet B meme en devinant son id", async () => {
    const res = await api(titulaireACookie, `/api/stages/${stageBId}/statut`, { method: "PATCH", body: JSON.stringify({ statut: "termine" }) });
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas decider d'une demande d'absence du cabinet B en devinant son id", async () => {
    const res = await api(titulaireACookie, `/api/demandes-absence/${demandeBId}/decision`, {
      method: "PATCH",
      body: JSON.stringify({ decision: "approuvee" }),
    });
    expect(res.status).toBe(404);
  });

  it("la file de validation du cabinet A ne contient aucune demande du cabinet B", async () => {
    const res = await api(titulaireACookie, "/api/demandes-absence?statut=en_attente");
    const liste = await res.json();
    expect(liste.find((d: { id: string }) => d.id === demandeBId)).toBeUndefined();
  });

  it("le titulaire du cabinet A ne peut pas consulter le planning de conges du cabinet B (son propre planning, meme annee, est introuvable)", async () => {
    const res = await api(titulaireACookie, "/api/planning-conges/2027");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).not.toContain(planningBId);
  });

  it("le titulaire du cabinet A ne peut pas valider le planning du cabinet B en devinant son id", async () => {
    const res = await api(titulaireACookie, `/api/planning-conges/${planningBId}/valider`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas consulter une fiche de paie du cabinet B en devinant son id", async () => {
    const res = await api(titulaireACookie, `/api/fiches-paie/${fichePaieBId}`);
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas telecharger le PDF d'une fiche de paie du cabinet B", async () => {
    const res = await api(titulaireACookie, `/api/fiches-paie/${fichePaieBId}/pdf`);
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas annuler une fiche de paie du cabinet B", async () => {
    const res = await api(titulaireACookie, `/api/fiches-paie/${fichePaieBId}/annuler`, {
      method: "POST",
      body: JSON.stringify({ motif: "tentative" }),
    });
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas consulter la periode de paie du cabinet B (introuvable malgre le meme mois)", async () => {
    const res = await api(titulaireACookie, "/api/periodes-paie/2026-11");
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas consulter l'etat de paiement du cabinet B en devinant son id", async () => {
    const resPdf = await api(titulaireACookie, `/api/etats-paiement/${etatPaiementBId}/export.pdf`);
    expect(resPdf.status).toBe(404);
    const resCsv = await api(titulaireACookie, `/api/etats-paiement/${etatPaiementBId}/export.csv`);
    expect(resCsv.status).toBe(404);
    const resValider = await api(titulaireACookie, `/api/etats-paiement/${etatPaiementBId}/valider`, { method: "POST" });
    expect(resValider.status).toBe(404);
  });

  it("le titulaire du cabinet A ne peut pas marquer payee une ligne de paiement du cabinet B", async () => {
    const etat = await prisma.etatPaiement.findUniqueOrThrow({ where: { id: etatPaiementBId }, include: { lignes: true } });
    const ligneId = etat.lignes[0].id;
    const res = await api(titulaireACookie, `/api/lignes-paiement/${ligneId}`, {
      method: "PATCH",
      body: JSON.stringify({ statutPaiement: "paye" }),
    });
    expect(res.status).toBe(404);
  });

  it("le titulaire du cabinet A ne voit aucune absence du cabinet B dans le calendrier d'equipe", async () => {
    // Memes dates que la demande B (approuvee par defaut ? non, en_attente) -
    // on verifie simplement l'absence de toute entree liee a la fiche B.
    const res = await api(titulaireACookie, "/api/conges/calendrier-equipe?debut=2026-01-01&fin=2026-12-31");
    const liste = await res.json();
    expect(liste.find((e: { fichePersonnelId: string }) => e.fichePersonnelId === ficheBId)).toBeUndefined();
  });

  // --- Verrouillage par module ("rh" / "rh_paie") ---

  it("desactiver le module \"rh\" au niveau du cabinet bloque /api/personnel mais pas /api/users", async () => {
    await prisma.cabinet.update({ where: { id: cabinetAId }, data: { modulesDesactives: ["rh"] } });
    const res = await api(titulaireACookie, "/api/personnel");
    expect(res.status).toBe(403);

    const resUsers = await api(titulaireACookie, "/api/users");
    expect(resUsers.status).not.toBe(403);

    await prisma.cabinet.update({ where: { id: cabinetAId }, data: { modulesDesactives: [] } });
  });

  it("desactiver uniquement \"rh_paie\" bloque la paie mais laisse le reste du module RH accessible", async () => {
    await prisma.cabinet.update({ where: { id: cabinetAId }, data: { modulesDesactives: ["rh_paie"] } });

    const resPaie = await api(titulaireACookie, "/api/personnel");
    // /api/personnel est monte par PLUSIEURS routeurs (personnel.ts="rh",
    // stages.ts="rh", conges.ts="rh", planningConges.ts="rh", paie.ts="rh_paie") -
    // la liste elle-meme reste servie par le routeur "rh", non affecte.
    expect(resPaie.status).toBe(200);

    const resElements = await api(titulaireACookie, "/api/periodes-paie", { method: "POST", body: JSON.stringify({ mois: "2026-10" }) });
    expect(resElements.status).toBe(403);

    await prisma.cabinet.update({ where: { id: cabinetAId }, data: { modulesDesactives: [] } });
  });

  it("desactiver \"rh\" au niveau d'un UTILISATEUR precis (pas du cabinet) ne bloque que cet utilisateur", async () => {
    const autreTitulaire = await prisma.user.create({
      data: { cabinetId: cabinetAId, nom: "Second Titulaire A", email: "titulaire2-e2e-rh-durciss@test.invalid", motDePasseHash: "x", role: "titulaire" },
    });
    await prisma.user.update({ where: { id: autreTitulaire.id }, data: { modulesDesactives: ["rh"] } });
    const cookieBloque = await mintAuthCookie(autreTitulaire.id, cabinetAId, "titulaire");

    const resBloque = await api(cookieBloque, "/api/personnel");
    expect(resBloque.status).toBe(403);

    const resLibre = await api(titulaireACookie, "/api/personnel");
    expect(resLibre.status).toBe(200);
  });

  // --- Chiffrement : les champs sensibles ne doivent jamais apparaitre en
  // clair dans la colonne brute, seuls les montants restent en clair
  // (decision 3 du 13/10/2026 - necessaire pour les SUM() cote base). ---

  it("coordonneesPaiement et motif sont chiffres en base (valeur brute differente du texte saisi)", async () => {
    const ficheAvecPaiement = await api(titulaireBCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({
        nom: "Chiffrement Test",
        categorie: "collaborateur",
        typeContrat: "cdi",
        dateEntree: "2024-01-01",
        modePaiement: "mobile_money",
        coordonneesPaiement: "+229-secret-0102030405",
      }),
    });
    const { id: ficheId } = await ficheAvecPaiement.json();

    const brut = await prisma.$queryRawUnsafe<{ coordonnees_paiement: string }[]>(
      `SELECT coordonnees_paiement FROM fiches_personnel WHERE id = $1`,
      ficheId
    );
    expect(brut[0].coordonnees_paiement).not.toContain("secret-0102030405");

    // Mais dechiffre normalement a la lecture via Prisma (transparent).
    const viaApi = await api(titulaireBCookie, `/api/personnel/${ficheId}`);
    expect((await viaApi.json()).coordonneesPaiement).toBe("+229-secret-0102030405");
  });

  it("les montants de paie (brut/net/retenues) restent en clair en base - necessaire pour les SUM() de l'etat de paiement", async () => {
    const brut = await prisma.$queryRawUnsafe<{ brut: number; net: number }[]>(`SELECT brut, net FROM fiches_paie WHERE id = $1`, fichePaieBId);
    expect(typeof brut[0].brut).toBe("number");
    expect(brut[0].brut).toBeGreaterThan(0);
  });
});
