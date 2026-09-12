/**
 * Lot 20 - registre de gestion des courriers (entrants/sortants) :
 * numerotation sequentielle/annuelle, creation "rapide" (objet seul), cycle
 * de statut avec historique, lien vers le module Delais existant, et
 * chainage bidirectionnel courrier entrant <-> reponse sortante.
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

describe.skipIf(!pgAvailable)("e2e : registre de gestion des courriers (Lot 20)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let titulaireId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("courriers"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-courriers-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "courriers");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");
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

  it("creation rapide : l'objet seul suffit, tous les autres champs restent vides sans erreur", async () => {
    const res = await api(titulaireCookie, "/api/courriers-entrants", {
      method: "POST",
      body: JSON.stringify({ objet: "Convocation à une audience" }),
    });
    expect(res.status).toBe(201);
    const courrier = await res.json();
    expect(courrier.objet).toBe("Convocation à une audience");
    expect(courrier.statut).toBe("recu");
    expect(courrier.nature).toBeNull();
    expect(courrier.expediteur).toBeNull();
    expect(courrier.dossierId).toBeNull();
    expect(courrier.numero).toMatch(/^ARR-\d{4}-\d{4}$/);

    const detail = await (await api(titulaireCookie, `/api/courriers-entrants/${courrier.id}`)).json();
    expect(detail.objet).toBe("Convocation à une audience");
  });

  it("deux courriers crees quasi simultanement recoivent des numeros distincts, jamais en collision", async () => {
    const reponses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api(titulaireCookie, "/api/courriers-entrants", {
          method: "POST",
          body: JSON.stringify({ objet: `Courrier concurrent ${i}` }),
        })
      )
    );
    expect(reponses.every((r) => r.status === 201)).toBe(true);
    const numeros = await Promise.all(reponses.map((r) => r.json().then((c) => c.numero)));
    expect(new Set(numeros).size).toBe(numeros.length);
  });

  it("la numerotation repart a 1 pour une nouvelle annee civile, independamment de l'annee precedente", async () => {
    await prisma.sequenceCourrier.create({
      data: { cabinetId, annee: 2020, sens: "entrant", dernierNumero: 42 },
    });

    const res = await api(titulaireCookie, "/api/courriers-entrants", {
      method: "POST",
      body: JSON.stringify({ objet: "Courrier de l'année en cours" }),
    });
    const courrier = await res.json();
    const anneeActuelle = new Date().getFullYear();
    expect(courrier.numero.startsWith(`ARR-${anneeActuelle}-`)).toBe(true);
    // La sequence de 2020 n'a jamais ete touchee par cette creation.
    const sequence2020 = await prisma.sequenceCourrier.findFirst({ where: { cabinetId, annee: 2020, sens: "entrant" } });
    expect(sequence2020?.dernierNumero).toBe(42);
  });

  it("cycle de statut complet avec historique horodate visible dans le Journal d'audit", async () => {
    const creation = await api(titulaireCookie, "/api/courriers-entrants", {
      method: "POST",
      body: JSON.stringify({ objet: "Mise en demeure à traiter" }),
    });
    const courrier = await creation.json();
    expect(courrier.statut).toBe("recu");

    const affectation = await api(titulaireCookie, `/api/courriers-entrants/${courrier.id}/affecter`, {
      method: "POST",
      body: JSON.stringify({ affecteAId: titulaireId }),
    });
    expect(affectation.status).toBe(200);
    expect((await affectation.json()).statut).toBe("affecte");

    for (const statut of ["en_traitement", "traite", "classe"]) {
      const res = await api(titulaireCookie, `/api/courriers-entrants/${courrier.id}/statut`, {
        method: "POST",
        body: JSON.stringify({ statut }),
      });
      expect(res.status).toBe(200);
    }

    const detail = await (await api(titulaireCookie, `/api/courriers-entrants/${courrier.id}`)).json();
    expect(detail.statut).toBe("classe");
    expect(detail.classeAt).not.toBeNull();
    const etapes = detail.auditLogs.map((log: { etape: string }) => log.etape);
    expect(etapes).toEqual(["creation", "affectation", "changement_statut", "changement_statut", "changement_statut"]);
    detail.auditLogs.forEach((log: { timestamp: string }) => expect(log.timestamp).toBeTruthy());
  });

  it("une transition de statut hors-cycle (ex: retour en arriere) est refusee", async () => {
    const creation = await api(titulaireCookie, "/api/courriers-entrants", {
      method: "POST",
      body: JSON.stringify({ objet: "Courrier pour test de transition invalide" }),
    });
    const courrier = await creation.json();
    await api(titulaireCookie, `/api/courriers-entrants/${courrier.id}/statut`, {
      method: "POST",
      body: JSON.stringify({ statut: "classe" }),
    });

    const retourEnArriere = await api(titulaireCookie, `/api/courriers-entrants/${courrier.id}/statut`, {
      method: "POST",
      body: JSON.stringify({ statut: "recu" }),
    });
    expect(retourEnArriere.status).toBe(409);
  });

  it("creer un delai depuis un courrier produit un delai identique a un delai cree normalement, visible dans Delais et le Calendrier", async () => {
    const dossier = await prisma.dossier.create({
      data: { cabinetId, numeroDossier: "DOS-COURRIER-1", nomAffaire: "Affaire Courrier", nomClient: "Client X", createdBy: titulaireId },
    });
    const delaiType = await prisma.delaiType.create({
      data: { cabinetId, nom: "Appel", nombreUnites: 30, unite: "jours", texteReference: "Art. X", createdById: titulaireId },
    });
    const creation = await api(titulaireCookie, "/api/courriers-entrants", {
      method: "POST",
      body: JSON.stringify({ objet: "Signification à délai", dossierId: dossier.id }),
    });
    const courrier = await creation.json();

    const res = await api(titulaireCookie, `/api/courriers-entrants/${courrier.id}/delai`, {
      method: "POST",
      body: JSON.stringify({ delaiTypeId: delaiType.id, dateDepart: "2026-01-01" }),
    });
    expect(res.status).toBe(201);
    const calcul = await res.json();
    expect(calcul.courrierEntrantId).toBe(courrier.id);
    expect(calcul.dossierId).toBe(dossier.id);

    // Visible dans le module Delais existant (meme table, meme route de
    // historique) - aucune duplication de la logique de calcul.
    const historique = await (await api(titulaireCookie, `/api/delais/historique?dossierId=${dossier.id}`)).json();
    expect(historique.some((h: { id: string }) => h.id === calcul.id)).toBe(true);

    // Visible dans le calendrier unifie (Evenement genere par le meme hook
    // que routes/delais.ts, evenementSync.ts).
    const delaiAvecEvenement = await prisma.delaiCalcul.findUnique({ where: { id: calcul.id }, include: { evenement: true } });
    expect(delaiAvecEvenement?.evenement).not.toBeNull();
  });

  it("repondre a un courrier cree un lien bidirectionnel visible entre le courrier d'origine et la reponse", async () => {
    const creation = await api(titulaireCookie, "/api/courriers-entrants", {
      method: "POST",
      body: JSON.stringify({ objet: "Demande du confrère", expediteur: "Maître Dupont" }),
    });
    const courrierEntrant = await creation.json();

    const reponse = await api(titulaireCookie, "/api/courriers-sortants", {
      method: "POST",
      body: JSON.stringify({ objet: "Réponse à la demande", destinataire: "Maître Dupont", reponseAId: courrierEntrant.id }),
    });
    expect(reponse.status).toBe(201);
    const courrierSortant = await reponse.json();
    expect(courrierSortant.numero).toMatch(/^DEP-\d{4}-\d{4}$/);

    const detailEntrant = await (await api(titulaireCookie, `/api/courriers-entrants/${courrierEntrant.id}`)).json();
    expect(detailEntrant.reponses.map((r: { id: string }) => r.id)).toContain(courrierSortant.id);

    const detailSortant = await (await api(titulaireCookie, `/api/courriers-sortants/${courrierSortant.id}`)).json();
    expect(detailSortant.reponseA.id).toBe(courrierEntrant.id);
  });

  it("les compteurs du tableau de bord reflet correctement un jeu de donnees varie", async () => {
    const avant = await (await api(titulaireCookie, "/api/courriers-entrants/compteurs")).json();

    await api(titulaireCookie, "/api/courriers-entrants", { method: "POST", body: JSON.stringify({ objet: "Compteur - reçu du jour" }) });
    const aAffecterRes = await api(titulaireCookie, "/api/courriers-entrants", { method: "POST", body: JSON.stringify({ objet: "Compteur - à affecter" }) });
    const aAffecter = await aAffecterRes.json();
    await api(titulaireCookie, `/api/courriers-entrants/${aAffecter.id}/statut`, { method: "POST", body: JSON.stringify({ statut: "a_affecter" }) });

    const apres = await (await api(titulaireCookie, "/api/courriers-entrants/compteurs")).json();
    expect(apres.recusAujourdhui).toBe(avant.recusAujourdhui + 2);
    expect(apres.aAffecter).toBe(avant.aAffecter + 1);
  });
});
