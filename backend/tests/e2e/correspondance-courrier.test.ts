/**
 * Lot "Répondre au courrier" (2026-09-13) - nouveau type de document
 * "correspondance" (le plus simple des types "rediger") : genere via IA
 * avec pseudonymisation du destinataire, lien automatique au courrier
 * entrant d'origine, et respect de la contrainte de confidentialite du lot
 * (le texte du courrier reçu est un texte libre DEJA relu/anonymise par
 * l'utilisateur - jamais retokenise ici, transmis tel quel au LLM, distinct
 * du destinataire qui lui est toujours pseudonymise).
 *
 * Tourne sur une base PostgreSQL de test jetable (voir full-workflow.test.ts),
 * avec un LLM mocke (aucun appel facture).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";
import { seedCabinetEtTitulaire, mintAuthCookie } from "./helpers/testApp";

const pgAvailable = findPostgresBinDir() !== null;

const { llmMock } = vi.hoisted(() => ({
  llmMock: {
    callCount: 0,
    lastUserPrompt: "",
  },
}));

vi.mock("../../src/services/llm", () => ({
  getLlmProvider: () => ({
    redact: async (_systemPrompt: string, userPrompt: string) => {
      llmMock.callCount++;
      llmMock.lastUserPrompt = userPrompt;
      // Reprend le token PARTIE_A dans la reponse simulee, comme le ferait un
      // vrai LLM en respectant le prompt pseudonymise - permet de verifier la
      // deanonymisation (voir full-workflow.test.ts, meme convention).
      return "Nous accusons réception du courrier de PARTIE_A et reviendrons vers vous sous huitaine.";
    },
    extractAction: vi.fn(),
  }),
  LlmOutputError: class LlmOutputError extends Error {},
}));

describe.skipIf(!pgAvailable)("e2e : correspondance générée depuis un courrier reçu", () => {
  let pg: TestPostgres;
  let server: Server;
  let baseUrl: string;
  let prisma: import("@prisma/client").PrismaClient;
  let fakeAppData: string;

  let titulaireCookie: string;
  let cabinetId: string;
  let titulaireId: string;
  let courrierEntrantId: string;
  const NOM_REEL_DESTINATAIRE = "Jean Kokou Dupont-N'Da";

  beforeAll(async () => {
    if (!pgAvailable) return;
    pg = (await startTestPostgres("correspondance-courrier"))!;

    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-e2e-correspondance-"));
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

    const { cabinet, user: titulaire } = await seedCabinetEtTitulaire(prisma, "correspondance-courrier");
    cabinetId = cabinet.id;
    titulaireId = titulaire.id;
    titulaireCookie = await mintAuthCookie(titulaire.id, cabinet.id, "titulaire");

    const courrier = await api(titulaireCookie, "/api/courriers-entrants", {
      method: "POST",
      body: JSON.stringify({ objet: "Demande de renseignements", expediteur: NOM_REEL_DESTINATAIRE }),
    }).then((r) => r.json());
    courrierEntrantId = courrier.id;
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

  it("genere une correspondance : le destinataire est pseudonymisé, le contenu du courrier reçu est transmis tel quel, l'action est liée au courrier", async () => {
    llmMock.callCount = 0;

    const res = await api(titulaireCookie, "/api/actions/web", {
      method: "POST",
      body: JSON.stringify({
        type_action: "correspondance",
        nom_affaire: "Affaire E2E Correspondance",
        nom_client: "Client Fictif",
        destinataire: NOM_REEL_DESTINATAIRE,
        objet: "Réponse à votre demande de renseignements",
        contenu_courrier_recu: "Texte déjà relu et anonymisé par l'avocat : [NOM DU CLIENT] souhaite des précisions sur le dossier.",
        instructions: "Accuser réception et annoncer une réponse sous huitaine.",
        courrier_entrant_id: courrierEntrantId,
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();

    expect(llmMock.callCount).toBe(1);
    // Le destinataire est bien pseudonymise avant l'appel LLM (Lot 5).
    expect(llmMock.lastUserPrompt).not.toContain(NOM_REEL_DESTINATAIRE);
    expect(llmMock.lastUserPrompt).toContain("PARTIE_A");
    // Le contenu du courrier recu (deja anonymise par l'utilisateur) est
    // transmis tel quel, jamais retokenise une seconde fois.
    expect(llmMock.lastUserPrompt).toContain("[NOM DU CLIENT] souhaite des précisions");
    expect(llmMock.lastUserPrompt).toContain("Accuser réception et annoncer une réponse sous huitaine.");

    // Le vrai nom reapparait dans le contenu final restitue (deanonymise).
    expect(body.contenu).toContain(NOM_REEL_DESTINATAIRE);

    const action = await prisma.action.findUnique({ where: { id: body.actionId } });
    expect(action?.typeAction).toBe("correspondance");
    expect(action?.donneesPseudonymisees).toBe(true);
    expect(action?.courrierEntrantId).toBe(courrierEntrantId);

    // Chainage visible depuis la fiche du courrier (voir courrierService.ts,
    // INCLUDE_ENTRANT_DETAIL.actions).
    const detailCourrier = await (await api(titulaireCookie, `/api/courriers-entrants/${courrierEntrantId}`)).json();
    expect(detailCourrier.actions.map((a: { id: string }) => a.id)).toContain(body.actionId);
  });

  it("ignore silencieusement un courrier_entrant_id appartenant à un AUTRE cabinet (jamais un lien croisé)", async () => {
    const { cabinet: autreCabinet, user: autreTitulaire } = await seedCabinetEtTitulaire(prisma, "correspondance-courrier-autre");
    const autreCookie = await mintAuthCookie(autreTitulaire.id, autreCabinet.id, "titulaire");
    const courrierAutreCabinet = await (
      await api(autreCookie, "/api/courriers-entrants", { method: "POST", body: JSON.stringify({ objet: "Courrier d'un autre cabinet" }) })
    ).json();

    const res = await api(titulaireCookie, "/api/actions/web", {
      method: "POST",
      body: JSON.stringify({
        type_action: "correspondance",
        destinataire: "Un destinataire quelconque",
        objet: "Test isolation cross-cabinet",
        courrier_entrant_id: courrierAutreCabinet.id,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();

    const action = await prisma.action.findUnique({ where: { id: body.actionId } });
    expect(action?.courrierEntrantId).toBeNull();
  });
});
