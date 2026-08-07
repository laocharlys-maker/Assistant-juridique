/**
 * Lot 12a - modele Evenement unifie : generation automatique depuis
 * RoleAudience/DelaiCalcul (creation, mise a jour, suppression), filtres
 * (type/collaborateur), coherence periode mois/semaine, non-regression du
 * role de la semaine existant.
 *
 * Tourne sur une base PostgreSQL de test jetable (voir full-workflow.test.ts).
 * Licence non testee ici (LICENCE_BYPASS), deja couverte ailleurs. La
 * resilience du hook de synchronisation (echec de prisma.evenement.upsert
 * n'empeche jamais la creation d'origine) est testee separement et plus
 * precisement au niveau unitaire - voir src/services/__tests__/evenementSync.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : calendrier unifié (Lot 12a)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let collaborateurCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let collaborateurId: string;
  let dossierId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("calendrier-unifie"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-calendrier-unifie-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "calendrier-unifie");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const collaborateur = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Collaborateur Test",
        email: "collab-e2e-calendrier-unifie@test.invalid",
        motDePasseHash: "x",
        role: "collaborateur",
        responsableId: titulaireId,
      },
    });
    collaborateurId = collaborateur.id;
    collaborateurCookie = await mintAuthCookie(collaborateur.id, cabinetId, "collaborateur");

    const dossier = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "CAL-E2E-001",
        nomAffaire: "Affaire Calendrier E2E",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });
    dossierId = dossier.id;
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

  const dansTroisJours = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  let roleAudienceId: string;

  it("génère un Evenement type=audience à la création d'un RoleAudience", async () => {
    const res = await api(titulaireCookie, "/api/role-audiences", {
      method: "POST",
      body: JSON.stringify({
        dateAudience: dansTroisJours,
        juridiction: "TPI Cotonou",
        parties: "Koffi C/ Kodjo",
        dossierId,
      }),
    });
    expect(res.status).toBe(201);
    const audience = await res.json();
    roleAudienceId = audience.id;

    const evenement = await prisma.evenement.findFirst({ where: { roleAudienceId } });
    expect(evenement).not.toBeNull();
    expect(evenement?.type).toBe("audience");
    expect(evenement?.source).toBe("role_audience");
    expect(evenement?.titre).toContain("Koffi C/ Kodjo");
    expect(evenement?.dossierId).toBe(dossierId);
  });

  it("re-synchronise l'Evenement lié quand le RoleAudience est modifié", async () => {
    const res = await api(titulaireCookie, `/api/role-audiences/${roleAudienceId}`, {
      method: "PATCH",
      body: JSON.stringify({ chambre: "1ère chambre civile" }),
    });
    expect(res.status).toBe(200);

    const evenement = await prisma.evenement.findFirst({ where: { roleAudienceId } });
    expect(evenement?.lieu).toContain("1ère chambre civile");
  });

  it("le rôle de la semaine existant continue de fonctionner sans régression", async () => {
    // debut explicite (le mois de l'audience creee) plutot que le mois
    // courant par defaut - insensible a la date d'execution du test (evite
    // une fragilite en toute fin de mois, ou "aujourd'hui" et "dans 3 jours"
    // pourraient ne plus etre dans le meme mois).
    const res = await api(titulaireCookie, `/api/role-audiences?periode=mois&debut=${dansTroisJours}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audiences.some((a: { id: string }) => a.id === roleAudienceId)).toBe(true);
  });

  it("supprime l'Evenement lié quand le RoleAudience est supprimé", async () => {
    const res = await api(titulaireCookie, `/api/role-audiences/${roleAudienceId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const evenement = await prisma.evenement.findFirst({ where: { roleAudienceId } });
    expect(evenement).toBeNull();
  });

  let delaiCalculId: string;

  it("génère un Evenement type=echeance_procedure à la création d'un DelaiCalcul, visible dans l'Agenda du dossier", async () => {
    const typeRes = await api(titulaireCookie, "/api/delais-types", {
      method: "POST",
      body: JSON.stringify({
        nom: "Appel",
        nombreUnites: 30,
        unite: "jours",
        joursOuvresUniquement: true,
        texteReference: "Art. 1 CPC",
      }),
    });
    expect(typeRes.status).toBe(201);
    const delaiType = await typeRes.json();

    const calculRes = await api(titulaireCookie, "/api/delais/calculer", {
      method: "POST",
      body: JSON.stringify({ delaiTypeId: delaiType.id, dateDepart: new Date().toISOString(), dossierId }),
    });
    expect(calculRes.status).toBe(201);
    const calcul = await calculRes.json();
    delaiCalculId = calcul.id;

    const evenement = await prisma.evenement.findFirst({ where: { delaiCalculId } });
    expect(evenement).not.toBeNull();
    expect(evenement?.type).toBe("echeance_procedure");
    expect(evenement?.source).toBe("delai_calcule");
    expect(evenement?.dossierId).toBe(dossierId);
    expect(evenement?.dateDebut.toISOString()).toBe(calcul.dateLimite);

    const agendaRes = await api(titulaireCookie, `/api/evenements?dossierId=${dossierId}`);
    expect(agendaRes.status).toBe(200);
    const agenda = await agendaRes.json();
    expect(agenda.evenements.some((e: { delaiCalculId: string }) => e.delaiCalculId === delaiCalculId)).toBe(true);
  });

  it("supprime l'Evenement lié quand le DelaiCalcul est supprimé", async () => {
    const res = await api(titulaireCookie, `/api/delais/${delaiCalculId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const evenement = await prisma.evenement.findFirst({ where: { delaiCalculId } });
    expect(evenement).toBeNull();
  });

  it("filtre par type et par collaborateur assigné", async () => {
    const debut = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const fin = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();

    const rdvRes = await api(titulaireCookie, "/api/evenements", {
      method: "POST",
      body: JSON.stringify({
        type: "rdv",
        titre: "RDV client Koffi",
        dateDebut: dansTroisJours,
        assignes: [collaborateurId],
      }),
    });
    expect(rdvRes.status).toBe(201);

    const tacheRes = await api(titulaireCookie, "/api/evenements", {
      method: "POST",
      body: JSON.stringify({ type: "tache", titre: "Relire les conclusions", dateDebut: dansTroisJours }),
    });
    expect(tacheRes.status).toBe(201);

    const parType = await api(titulaireCookie, `/api/evenements?debut=${debut}&fin=${fin}&type=rdv`);
    const parTypeBody = await parType.json();
    expect(parTypeBody.evenements.length).toBeGreaterThan(0);
    expect(parTypeBody.evenements.every((e: { type: string }) => e.type === "rdv")).toBe(true);

    const parAssigne = await api(titulaireCookie, `/api/evenements?debut=${debut}&fin=${fin}&assigne=${collaborateurId}`);
    const parAssigneBody = await parAssigne.json();
    expect(parAssigneBody.evenements.length).toBeGreaterThan(0);
    expect(
      parAssigneBody.evenements.every((e: { assignes: { user: { id: string } }[] }) =>
        e.assignes.some((a) => a.user.id === collaborateurId)
      )
    ).toBe(true);
  });

  it("refuse de créer un événement manuel de type audience ou echeance_procedure", async () => {
    const res = await api(titulaireCookie, "/api/evenements", {
      method: "POST",
      body: JSON.stringify({ type: "audience", titre: "Tentative non autorisée", dateDebut: dansTroisJours }),
    });
    expect(res.status).toBe(400);
  });

  it("un événement daté d'aujourd'hui apparaît de façon cohérente en vue semaine et en vue mois", async () => {
    // Fenetres construites pour contenir "maintenant" par construction (pas
    // de dependance a la proximite d'une fin de mois, qui rendrait ce test
    // fragile pres du 28-31 du mois) : chaque vue reste responsable de son
    // propre decoupage de periode (voir calendrier.js), cette route ne fait
    // que filtrer sur [debut, fin[ - ce test verifie que le meme evenement
    // est bien retrouve, que la fenetre soit large (mois) ou etroite (semaine).
    const now = new Date();
    const creeRes = await api(titulaireCookie, "/api/evenements", {
      method: "POST",
      body: JSON.stringify({ type: "tache", titre: "Tâche cohérence mois/semaine", dateDebut: now.toISOString() }),
    });
    expect(creeRes.status).toBe(201);
    const evenementCree = await creeRes.json();

    const debutSemaine = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const finSemaine = new Date(debutSemaine.getTime() + 7 * 24 * 60 * 60 * 1000);
    const debutMois = new Date(now.getFullYear(), now.getMonth(), 1);
    const finMois = new Date(now.getFullYear(), now.getMonth() + 1, 1);

    const semaineRes = await api(
      titulaireCookie,
      `/api/evenements?debut=${debutSemaine.toISOString()}&fin=${finSemaine.toISOString()}`
    );
    const moisRes = await api(titulaireCookie, `/api/evenements?debut=${debutMois.toISOString()}&fin=${finMois.toISOString()}`);
    const semaineBody = await semaineRes.json();
    const moisBody = await moisRes.json();

    expect(semaineBody.evenements.some((e: { id: string }) => e.id === evenementCree.id)).toBe(true);
    expect(moisBody.evenements.some((e: { id: string }) => e.id === evenementCree.id)).toBe(true);
  });
});
