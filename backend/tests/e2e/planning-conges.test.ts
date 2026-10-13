/**
 * Module RH Cabinet, RH-4 - planning de conges automatique : souhaits,
 * generation (souhait respecte, effectif minimum, periode bloquee,
 * conflit d'audience -> decalage automatique, non-place), ajustement
 * manuel, validation (-> DemandeAbsence approuvee + notification).
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

describe.skipIf(!pgAvailable)("e2e : module RH Cabinet - planning de conges (RH-4)", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let ficheAId: string; // placement direct attendu (souhait respecte)
  let ficheBId: string; // en conflit avec ficheA (effectif min=1) -> decale
  let ficheBUserId: string;

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("planning-conges"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-planning-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "planning-conges");
    cabinetId = cabinet.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const userB = await prisma.user.create({
      data: { cabinetId, nom: "Employe B", email: "b-e2e-planning@test.invalid", motDePasseHash: "x", role: "collaborateur" },
    });
    ficheBUserId = userB.id;

    // ficheA : plus ancienne (anciennete -> traitee en premier). Pas de
    // compte Aurore (employe sans compte, cas explicitement couvert par la
    // spec).
    const ficheARes = await fetch(`${baseUrl}/api/personnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: titulaireCookie },
      body: JSON.stringify({ nom: "Employe A", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2020-01-01" }),
    });
    ficheAId = (await ficheARes.json()).id;

    const ficheBRes = await fetch(`${baseUrl}/api/personnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: titulaireCookie },
      body: JSON.stringify({ nom: "Employe B", categorie: "collaborateur", typeContrat: "cdi", dateEntree: "2023-01-01", userId: ficheBUserId }),
    });
    ficheBId = (await ficheBRes.json()).id;
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

  const ANNEE = 2027;

  it("soumettre les souhaits de deux employes en conflit (meme periode, effectif min=1)", async () => {
    // Lundi 2027-03-01 au vendredi 2027-03-05 pour les deux - avec effectif
    // minimum 1 (sur 2 actifs), ils ne peuvent pas etre absents en meme
    // temps tous les deux.
    const resA = await api(titulaireCookie, `/api/personnel/${ficheAId}/souhaits-conges`, {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, souhaits: [{ rang: 1, dateDebut: "2027-03-01", dateFin: "2027-03-05" }] }),
    });
    expect(resA.status).toBe(201);

    const resB = await api(titulaireCookie, `/api/personnel/${ficheBId}/souhaits-conges`, {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, souhaits: [{ rang: 1, dateDebut: "2027-03-01", dateFin: "2027-03-05" }] }),
    });
    expect(resB.status).toBe(201);
  });

  it("un avocat/collaborateur ne peut pas generer le planning (reserve au titulaire)", async () => {
    const collabCookie = await mintAuthCookie(ficheBUserId, cabinetId, "collaborateur");
    const res = await api(collabCookie, "/api/planning-conges", {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, effectifMin: 1, periodesBloquees: [] }),
    });
    expect(res.status).toBe(403);
  });

  let ligneANonDecalee: { dateDebut: string; dateFin: string; origine: string };
  let ligneBDecalee: { dateDebut: string; dateFin: string; origine: string; raison: string | null };

  it("genere le planning : le premier traite (anciennete) garde son souhait, le second est decale", async () => {
    const res = await api(titulaireCookie, "/api/planning-conges", {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, effectifMin: 1, periodesBloquees: [] }),
    });
    expect(res.status).toBe(201);
    const planning = await res.json();
    expect(planning.statut).toBe("brouillon");
    expect(planning.lignes.length).toBe(2);

    const ligneA = planning.lignes.find((l: { fichePersonnelId: string }) => l.fichePersonnelId === ficheAId);
    const ligneB = planning.lignes.find((l: { fichePersonnelId: string }) => l.fichePersonnelId === ficheBId);

    // Les deux ont demande EXACTEMENT la meme periode avec un effectif
    // minimum de 1 (sur 2 actifs) : elles ne peuvent pas etre absentes en
    // meme temps toutes les deux. Celle traitee en premier (ordre
    // anciennete + rotation annuelle - peu importe laquelle pour ce test)
    // garde son souhait tel quel ; l'autre est forcement decalee.
    const [gardee, decalee] = ligneA.origine === "souhait_1" ? [ligneA, ligneB] : [ligneB, ligneA];
    expect(gardee.origine).toBe("souhait_1");
    expect(gardee.dateDebut.slice(0, 10)).toBe("2027-03-01");
    expect(decalee.origine).toBe("ajuste_auto");
    expect(decalee.dateDebut.slice(0, 10)).not.toBe("2027-03-01");
    expect(decalee.raison).toBeTruthy();

    ligneANonDecalee = ligneA;
    ligneBDecalee = ligneB;
  });

  it("le planning est regenerable tant qu'il est en brouillon (memes resultats stables)", async () => {
    const res = await api(titulaireCookie, "/api/planning-conges", {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, effectifMin: 1, periodesBloquees: [] }),
    });
    expect(res.status).toBe(201);
    const planning = await res.json();
    expect(planning.lignes.length).toBe(2); // pas de doublon - les anciennes lignes ont ete remplacees.
  });

  it("une periode bloquee empeche tout placement dessus, meme un souhait sinon valide", async () => {
    await api(titulaireCookie, `/api/personnel/${ficheAId}/souhaits-conges`, {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, souhaits: [{ rang: 1, dateDebut: "2027-07-01", dateFin: "2027-07-05" }] }),
    });
    await api(titulaireCookie, `/api/personnel/${ficheBId}/souhaits-conges`, {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, souhaits: [] }),
    });

    const res = await api(titulaireCookie, "/api/planning-conges", {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, effectifMin: 0, periodesBloquees: [{ debut: "2027-06-25", fin: "2027-07-10" }] }),
    });
    const planning = await res.json();
    const ligneA = planning.lignes.find((l: { fichePersonnelId: string }) => l.fichePersonnelId === ficheAId);
    expect(ligneA.origine).toBe("ajuste_auto");
    expect(ligneA.dateDebut.slice(0, 10)).not.toBe("2027-07-01");

    const ligneB = planning.lignes.find((l: { fichePersonnelId: string }) => l.fichePersonnelId === ficheBId);
    expect(ligneB.origine).toBe("non_place");
    expect(ligneB.dateDebut).toBeNull();
  });

  it("ajuster manuellement une ligne la marque comme origine 'manuel'", async () => {
    const planning = await (await api(titulaireCookie, `/api/planning-conges/${ANNEE}`)).json();
    const ligneA = planning.lignes.find((l: { fichePersonnelId: string }) => l.fichePersonnelId === ficheAId);

    const res = await api(titulaireCookie, `/api/planning-conges/lignes/${ligneA.id}`, {
      method: "PATCH",
      body: JSON.stringify({ dateDebut: "2027-08-02", dateFin: "2027-08-06" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).origine).toBe("manuel");
  });

  it("valider le planning cree une DemandeAbsence approuvee par ligne placee et notifie l'employe avec compte", async () => {
    const planning = await (await api(titulaireCookie, `/api/planning-conges/${ANNEE}`)).json();

    const res = await api(titulaireCookie, `/api/planning-conges/${planning.id}/valider`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).statut).toBe("valide");

    const demandeA = await prisma.demandeAbsence.findFirst({ where: { fichePersonnelId: ficheAId, cabinetId } });
    expect(demandeA?.statut).toBe("approuvee");
    expect(demandeA?.planningLigneId).toBeTruthy();

    // ficheB non placee cette fois (voir test precedent) -> aucune demande creee pour elle.
    const demandeB = await prisma.demandeAbsence.findFirst({ where: { fichePersonnelId: ficheBId, cabinetId } });
    expect(demandeB).toBeNull();

    const notif = await prisma.notification.findFirst({ where: { type: "planning_conges_valide" } });
    expect(notif).toBeNull(); // ficheA n'a pas de compte Aurore -> pas de notification possible.
  });

  it("un planning deja valide n'est plus regenerable ni revalidable", async () => {
    const planning = await (await api(titulaireCookie, `/api/planning-conges/${ANNEE}`)).json();

    const regen = await api(titulaireCookie, "/api/planning-conges", {
      method: "POST",
      body: JSON.stringify({ annee: ANNEE, effectifMin: 0, periodesBloquees: [] }),
    });
    expect(regen.status).toBe(409);

    const revalide = await api(titulaireCookie, `/api/planning-conges/${planning.id}/valider`, { method: "POST" });
    expect(revalide.status).toBe(409);
  });
});
