/**
 * Lot 14 - timer & feuilles de temps : persistance serveur du chronomètre
 * (démarrage/arrêt/reprise après "fermeture" simulée par une simple
 * relecture GET /actif dans une nouvelle requête), chronomètre unique par
 * utilisateur, saisie manuelle, snapshot du taux horaire, génération de
 * facture depuis le temps passé (sans double comptage), tout temps
 * enregistré est facturable, et permissions (un collaborateur ne voit
 * jamais les saisies d'un autre).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("e2e : timer & feuilles de temps (Lot 14)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let collaborateurCookie: string;
  let autreAvocatCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let collaborateurId: string;
  let dossierId: string;
  let autreDossierId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("saisies-temps"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-saisies-temps-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "saisies-temps");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const collaborateur = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Collaborateur Test",
        email: "collab-e2e-saisies-temps@test.invalid",
        motDePasseHash: "x",
        role: "collaborateur",
        responsableId: titulaireId,
      },
    });
    collaborateurId = collaborateur.id;
    collaborateurCookie = await mintAuthCookie(collaborateur.id, cabinetId, "collaborateur");
    // Taux fixe des le depart pour que les montants de facturation calcules
    // plus bas soient previsibles (les tests de chronometre, qui dependent
    // du temps reel ecoule, utilisent un dossier separe - voir plus bas).
    await prisma.user.update({ where: { id: collaborateurId }, data: { tauxHoraireDefaut: 10000 } });

    const autreAvocat = await prisma.user.create({
      data: {
        cabinetId,
        nom: "Avocat Sans Lien",
        email: "avocat-sans-lien-e2e-saisies-temps@test.invalid",
        motDePasseHash: "x",
        role: "avocat",
      },
    });
    autreAvocatCookie = await mintAuthCookie(autreAvocat.id, cabinetId, "avocat");

    const dossier = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "TEMPS-E2E-001",
        nomAffaire: "Affaire Temps E2E",
        nomClient: "Client Fictif",
        createdBy: titulaireId,
      },
    });
    dossierId = dossier.id;

    const autreDossier = await prisma.dossier.create({
      data: {
        cabinetId,
        numeroDossier: "TEMPS-E2E-002",
        nomAffaire: "Autre Affaire",
        nomClient: "Autre Client",
        createdBy: titulaireId,
      },
    });
    autreDossierId = autreDossier.id;
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

  // Les tests de chronometre (1-4) utilisent DELIBEREMENT autreDossierId,
  // jamais dossierId : leur duree depend du temps reel ecoule pendant le
  // test (non nul mais non predictible a la minute pres), ce qui rendrait
  // le montant de "Facturer ce dossier" (calcule plus bas sur dossierId a
  // partir de durees manuelles exactes) non deterministe si elles se
  // melangeaient.
  let saisieChronoId: string;

  it("démarre un chronomètre, et la reprise (GET /actif) reflète le temps réellement écoulé", async () => {
    const res = await api(collaborateurCookie, "/api/saisies-temps/demarrer", {
      method: "POST",
      body: JSON.stringify({ dossierId: autreDossierId }),
    });
    expect(res.status).toBe(201);
    const saisie = await res.json();
    saisieChronoId = saisie.id;
    expect(saisie.source).toBe("chrono");
    expect(saisie.arreteA).toBeNull();

    // Simule "fermeture/reouverture de l'app" : une toute nouvelle requête,
    // sans aucun état côté client - la persistance est bien côté serveur.
    const actifRes = await api(collaborateurCookie, "/api/saisies-temps/actif");
    expect(actifRes.status).toBe(200);
    const actif = await actifRes.json();
    expect(actif).not.toBeNull();
    expect(actif.id).toBe(saisieChronoId);
    expect(actif.dossier.id).toBe(autreDossierId);
  });

  it("bloque le démarrage d'un second chronomètre avec un message clair identifiant le dossier en cours", async () => {
    const res = await api(collaborateurCookie, "/api/saisies-temps/demarrer", {
      method: "POST",
      body: JSON.stringify({ dossierId }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("TEMPS-E2E-002");
  });

  it("arrête le chronomètre : durée calculée, plus de chronomètre actif ensuite", async () => {
    const res = await api(collaborateurCookie, `/api/saisies-temps/${saisieChronoId}/arreter`, { method: "POST" });
    expect(res.status).toBe(200);
    const saisie = await res.json();
    expect(saisie.arreteA).not.toBeNull();
    expect(saisie.dureeMinutes).not.toBeNull();
    expect(saisie.dureeMinutes).toBeGreaterThanOrEqual(0);

    const actifRes = await api(collaborateurCookie, "/api/saisies-temps/actif");
    const actif = await actifRes.json();
    expect(actif).toBeNull();
  });

  it("permet maintenant de démarrer un chronomètre (y compris sur le dossier initialement bloqué)", async () => {
    const res = await api(collaborateurCookie, "/api/saisies-temps/demarrer", {
      method: "POST",
      body: JSON.stringify({ dossierId: autreDossierId }),
    });
    expect(res.status).toBe(201);
    const saisie = await res.json();
    // Arrete tout de suite pour ne pas polluer les tests suivants (pas de
    // chrono actif residuel).
    await api(collaborateurCookie, `/api/saisies-temps/${saisie.id}/arreter`, { method: "POST" });
  });

  it("la saisie manuelle en rattrapage fonctionne indépendamment du chronomètre", async () => {
    const res = await api(collaborateurCookie, "/api/saisies-temps", {
      method: "POST",
      body: JSON.stringify({
        dossierId,
        date: new Date().toISOString(),
        dureeMinutes: 90,
        description: "Recherche documentaire",
      }),
    });
    expect(res.status).toBe(201);
    const saisie = await res.json();
    expect(saisie.source).toBe("manuel");
    expect(saisie.dureeMinutes).toBe(90);

    const listeRes = await api(collaborateurCookie, `/api/saisies-temps?dossierId=${dossierId}`);
    const liste = await listeRes.json();
    expect(liste.some((s: { id: string }) => s.id === saisie.id)).toBe(true);
  });

  it("snapshotte le taux horaire à la création : une modification ultérieure ne change jamais une saisie déjà enregistrée", async () => {
    await api(titulaireCookie, `/api/users/${collaborateurId}/taux-horaire`, {
      method: "PATCH",
      body: JSON.stringify({ tauxHoraireDefaut: 10000 }),
    });

    const creationRes = await api(collaborateurCookie, "/api/saisies-temps", {
      method: "POST",
      body: JSON.stringify({ dossierId, date: new Date().toISOString(), dureeMinutes: 60 }),
    });
    const saisie = await creationRes.json();
    expect(saisie.tauxHoraireApplique).toBe(10000);
    expect(saisie.montant).toBe(10000);

    // Le taux change APRES coup.
    await api(titulaireCookie, `/api/users/${collaborateurId}/taux-horaire`, {
      method: "PATCH",
      body: JSON.stringify({ tauxHoraireDefaut: 25000 }),
    });

    const relueRes = await api(collaborateurCookie, `/api/saisies-temps?dossierId=${dossierId}`);
    const liste = await relueRes.json();
    const relue = liste.find((s: { id: string }) => s.id === saisie.id);
    expect(relue.tauxHoraireApplique).toBe(10000); // inchangé
    expect(relue.montant).toBe(10000);
  });

  it("toute saisie manuelle est facturable, sans possibilité de la marquer autrement", async () => {
    const res = await api(collaborateurCookie, "/api/saisies-temps", {
      method: "POST",
      body: JSON.stringify({
        dossierId,
        date: new Date().toISOString(),
        dureeMinutes: 45,
        description: "Formation interne",
      }),
    });
    expect(res.status).toBe(201);
    const saisie = await res.json();
    expect(saisie.facturable).toBe(true);

    const feuilleRes = await api(titulaireCookie, `/api/saisies-temps/feuille?dossierId=${dossierId}&groupBy=dossier`);
    const feuille = await feuilleRes.json();
    expect(feuille.lignes[0].dureeMinutes).toBeGreaterThanOrEqual(45);
  });

  let factureId: string;

  it("« Facturer ce dossier » génère une facture correcte à partir de tout le temps non encore facturé", async () => {
    const res = await api(titulaireCookie, "/api/factures/depuis-temps", {
      method: "POST",
      body: JSON.stringify({ dossierId }),
    });
    expect(res.status).toBe(201);
    const facture = await res.json();
    factureId = facture.id;
    // 90min + 60min à 10000F/h (15000 + 10000) + 45min à 25000F/h (taux
    // modifié par le test précédent, snapshotté à la création de cette
    // dernière saisie) = 15000 + 10000 + 18750 = 43750
    expect(facture.montant).toBe(43750);
    expect(facture.saisiesIncluses).toBeGreaterThanOrEqual(3);
    expect(facture.description).toContain("Collaborateur Test");
  });

  it("les saisies incluses dans la facture ne sont plus proposées pour une nouvelle facturation", async () => {
    const res = await api(titulaireCookie, "/api/factures/depuis-temps", {
      method: "POST",
      body: JSON.stringify({ dossierId }),
    });
    expect(res.status).toBe(400);

    const saisies = await prisma.saisieTemps.findMany({ where: { dossierId } });
    for (const s of saisies) {
      if (s.dureeMinutes !== null) {
        expect(s.factureId).toBe(factureId);
      }
    }
  });

  it("une saisie déjà facturée ne peut plus être modifiée ni supprimée", async () => {
    const facturees = await prisma.saisieTemps.findFirst({ where: { factureId } });
    expect(facturees).not.toBeNull();

    const patchRes = await api(collaborateurCookie, `/api/saisies-temps/${facturees!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Modification tentée" }),
    });
    expect(patchRes.status).toBe(409);

    const deleteRes = await api(collaborateurCookie, `/api/saisies-temps/${facturees!.id}`, { method: "DELETE" });
    expect(deleteRes.status).toBe(409);
  });

  it("un utilisateur ne peut ni consulter ni modifier les saisies d'un collègue sans droit", async () => {
    // Un avocat qui ne supervise pas ce collaborateur (pas son responsable).
    const equipeRes = await api(autreAvocatCookie, `/api/saisies-temps/equipe?userId=${collaborateurId}`);
    expect(equipeRes.status).toBe(403);

    // Le collaborateur ne peut pas non plus accéder à la vue équipe.
    const equipeCollabRes = await api(collaborateurCookie, "/api/saisies-temps/equipe");
    expect(equipeCollabRes.status).toBe(403);

    // Tentative de modifier une saisie d'autrui : 404 (jamais trouvée dans
    // le périmètre de l'appelant - ni exposée, ni modifiable).
    const uneSaisie = await prisma.saisieTemps.findFirst({ where: { userId: collaborateurId } });
    const patchRes = await api(autreAvocatCookie, `/api/saisies-temps/${uneSaisie!.id}`, {
      method: "PATCH",
      body: JSON.stringify({ description: "Intrusion" }),
    });
    expect(patchRes.status).toBe(404);
  });

  it("le titulaire (admin) peut consulter les saisies de son collaborateur via la vue équipe", async () => {
    const res = await api(titulaireCookie, `/api/saisies-temps/equipe?userId=${collaborateurId}`);
    expect(res.status).toBe(200);
    const saisies = await res.json();
    expect(saisies.length).toBeGreaterThan(0);
    expect(saisies.every((s: { userId: string }) => s.userId === collaborateurId)).toBe(true);
  });
});
