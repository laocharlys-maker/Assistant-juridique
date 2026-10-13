/**
 * Module RH Cabinet, RH-3 - conges : types par defaut, jours feries,
 * calcul des jours ouvres (week-end + feries + demi-journees), solde,
 * demandes (creation/validation/refus/annulation), perimetre de
 * permissions (validation reservee au titulaire), et calendrier d'equipe
 * SANS motif.
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

describe.skipIf(!pgAvailable)("e2e : module RH Cabinet - conges (RH-3)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let avocatCookie: string;
  let avocatId: string;
  let ficheAvocatId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("conges"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-conges-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "conges");
    cabinetId = cabinet.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const avocat = await prisma.user.create({
      data: { cabinetId, nom: "Avocat Test", email: "avocat2-e2e-conges@test.invalid", motDePasseHash: "x", role: "avocat" },
    });
    avocatId = avocat.id;
    avocatCookie = await mintAuthCookie(avocat.id, cabinetId, "avocat");

    const ficheRes = await fetch(`${baseUrl}/api/personnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: titulaireCookie },
      body: JSON.stringify({ nom: "Avocat Test", categorie: "avocat", typeContrat: "cdi", dateEntree: "2021-01-01", userId: avocatId }),
    });
    ficheAvocatId = (await ficheRes.json()).id;
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

  it("les types d'absence par defaut sont crees automatiquement au premier appel", async () => {
    const res = await api(titulaireCookie, "/api/types-absence");
    expect(res.status).toBe(200);
    const types = await res.json();
    expect(types.length).toBe(6);
    expect(types.map((t: { libelle: string }) => t.libelle)).toContain("Congé annuel");
  });

  it("le titulaire peut fixer un solde de conges pour un employe", async () => {
    const res = await api(titulaireCookie, `/api/personnel/${ficheAvocatId}/solde-conges`, {
      method: "PATCH",
      body: JSON.stringify({ annee: 2026, droitJours: 24, reportJours: 2 }),
    });
    expect(res.status).toBe(200);

    const solde = await (await api(avocatCookie, `/api/personnel/${ficheAvocatId}/solde-conges?annee=2026`)).json();
    expect(solde.droitJours).toBe(24);
    expect(solde.reportJours).toBe(2);
    expect(solde.joursPris).toBe(0);
    expect(solde.soldeRestant).toBe(26);
  });

  let congeAnnuelId: string;
  let demandeId: string;

  it("poser une demande calcule correctement les jours ouvres (week-end exclu)", async () => {
    const types = await (await api(avocatCookie, "/api/types-absence")).json();
    congeAnnuelId = types.find((t: { libelle: string }) => t.libelle === "Congé annuel").id;

    // Lundi 2026-06-01 au vendredi 2026-06-05 : 5 jours ouvres, aucun week-end.
    const res = await api(avocatCookie, `/api/personnel/${ficheAvocatId}/demandes-absence`, {
      method: "POST",
      body: JSON.stringify({ typeAbsenceId: congeAnnuelId, dateDebut: "2026-06-01", dateFin: "2026-06-05" }),
    });
    expect(res.status).toBe(201);
    const demande = await res.json();
    expect(demande.nbJoursOuvres).toBe(5);
    expect(demande.statut).toBe("en_attente");
    demandeId = demande.id;
  });

  it("une periode incluant un week-end exclut bien samedi/dimanche du decompte", async () => {
    // Vendredi 2026-06-26 au lundi 2026-06-29 : vendredi + lundi = 2 jours ouvres.
    const res = await api(avocatCookie, `/api/personnel/${ficheAvocatId}/demandes-absence`, {
      method: "POST",
      body: JSON.stringify({ typeAbsenceId: congeAnnuelId, dateDebut: "2026-06-26", dateFin: "2026-06-29" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).nbJoursOuvres).toBe(2);
  });

  it("une demi-journee de debut retire 0.5 jour", async () => {
    // Lundi 2026-07-06 (apres-midi seulement) au lundi 2026-07-06 : 0.5 jour.
    const res = await api(avocatCookie, `/api/personnel/${ficheAvocatId}/demandes-absence`, {
      method: "POST",
      body: JSON.stringify({ typeAbsenceId: congeAnnuelId, dateDebut: "2026-07-06", dateFin: "2026-07-06", demiJourneeDebut: true }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).nbJoursOuvres).toBe(0.5);
  });

  it("un collaborateur sans fiche (ou une fiche d'autrui) ne peut pas poser de demande pour un autre", async () => {
    const autreFicheRes = await api(titulaireCookie, "/api/personnel", {
      method: "POST",
      body: JSON.stringify({ nom: "Autrui", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2023-01-01" }),
    });
    const autreFiche = await autreFicheRes.json();

    const res = await api(avocatCookie, `/api/personnel/${autreFiche.id}/demandes-absence`, {
      method: "POST",
      body: JSON.stringify({ typeAbsenceId: congeAnnuelId, dateDebut: "2026-08-01", dateFin: "2026-08-01" }),
    });
    expect(res.status).toBe(403);
  });

  it("un avocat ne peut pas valider ses propres demandes (reserve au titulaire)", async () => {
    const res = await api(avocatCookie, `/api/demandes-absence/${demandeId}/decision`, {
      method: "PATCH",
      body: JSON.stringify({ decision: "approuvee" }),
    });
    expect(res.status).toBe(403);
  });

  it("le titulaire approuve la demande, le solde restant diminue en consequence", async () => {
    const res = await api(titulaireCookie, `/api/demandes-absence/${demandeId}/decision`, {
      method: "PATCH",
      body: JSON.stringify({ decision: "approuvee", commentaire: "Bonnes vacances" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).statut).toBe("approuvee");

    const solde = await (await api(titulaireCookie, `/api/personnel/${ficheAvocatId}/solde-conges?annee=2026`)).json();
    expect(solde.joursPris).toBe(5);
    expect(solde.soldeRestant).toBe(21); // 24 + 2 - 5
  });

  it("une demande deja decidee ne peut pas etre decidee une seconde fois", async () => {
    const res = await api(titulaireCookie, `/api/demandes-absence/${demandeId}/decision`, {
      method: "PATCH",
      body: JSON.stringify({ decision: "refusee" }),
    });
    expect(res.status).toBe(409);
  });

  it("le calendrier d'equipe affiche 'Absent' sans jamais exposer le motif ni le type", async () => {
    const res = await api(avocatCookie, "/api/conges/calendrier-equipe?debut=2026-06-01&fin=2026-06-05");
    expect(res.status).toBe(200);
    const absences = await res.json();
    expect(absences.length).toBe(1);
    expect(absences[0].libelle).toBe("Absent");
    expect(absences[0]).not.toHaveProperty("motif");
    expect(absences[0]).not.toHaveProperty("typeAbsence");
  });

  it("l'employe peut annuler sa propre demande en attente, mais pas apres decision", async () => {
    const nouvelle = await api(avocatCookie, `/api/personnel/${ficheAvocatId}/demandes-absence`, {
      method: "POST",
      body: JSON.stringify({ typeAbsenceId: congeAnnuelId, dateDebut: "2026-09-01", dateFin: "2026-09-01" }),
    });
    const { id } = await nouvelle.json();

    const annulation = await api(avocatCookie, `/api/demandes-absence/${id}/annuler`, { method: "POST" });
    expect(annulation.status).toBe(200);
    expect((await annulation.json()).statut).toBe("annulee");

    // demandeId (deja approuvee) ne peut plus etre annulee par l'employe.
    const annulationRefusee = await api(avocatCookie, `/api/demandes-absence/${demandeId}/annuler`, { method: "POST" });
    expect(annulationRefusee.status).toBe(403);
  });
});
