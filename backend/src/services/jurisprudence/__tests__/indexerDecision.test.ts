import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * indexerDecision() est desormais partagee par deux points d'entree (voir
 * routes/jurisprudenceBase.ts et routes/webActions.ts, "resume_pdf") - le
 * chemin "nettoyage -> chunking -> embedding -> insertion" lui-meme est deja
 * couvert par src/routes/__tests__/jurisprudenceBase.test.ts (au niveau
 * route). Ce fichier couvre specifiquement le comportement propre a cette
 * extraction : le groupeId peut etre fourni a l'avance par l'appelant
 * (necessaire pour construire le lien interne AVANT d'indexer, voir
 * routes/webActions.ts) ou genere automatiquement sinon.
 */

const prismaMock = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("../../../lib/prisma", () => ({ prisma: prismaMock }));

const embedTextMock = vi.hoisted(() => vi.fn());
vi.mock("../../embeddings", () => ({
  embedText: embedTextMock,
  toVectorLiteral: (embedding: number[]) => `[${embedding.join(",")}]`,
}));

let indexerDecision: typeof import("../indexerDecision").indexerDecision;

beforeEach(async () => {
  vi.clearAllMocks();
  embedTextMock.mockResolvedValue([0.1, 0.2]);
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $executeRawUnsafe: vi.fn() })
  );
  ({ indexerDecision } = await import("../indexerDecision"));
});

afterEach(() => {
  vi.resetModules();
});

describe("indexerDecision", () => {
  it("génère un groupeId si aucun n'est fourni", async () => {
    const resultat = await indexerDecision({
      source: "Cour Suprême",
      reference: "Arrêt n° 1/2026",
      juridiction: null,
      dateDecision: null,
      contenuBrut: "Contenu suffisamment long pour être indexé sans problème particulier.",
      lien: null,
    });
    expect(resultat.groupeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(resultat.chunkCount).toBe(1);
  });

  it("réutilise le groupeId fourni par l'appelant (passerelle resume PDF -> jurisprudence)", async () => {
    const groupeIdImpose = "groupe-fourni-par-webactions";
    const resultat = await indexerDecision({
      source: "Décision importée (PDF)",
      reference: "Arrêt n° 2/2026",
      juridiction: null,
      dateDecision: null,
      contenuBrut: "Contenu suffisamment long pour être indexé sans problème particulier.",
      lien: "/api/jurisprudence-base/groupe-fourni-par-webactions/document",
      groupeId: groupeIdImpose,
    });
    expect(resultat.groupeId).toBe(groupeIdImpose);
  });

  it("insère le contenu brut nettoyé (pas de transformation vers un résumé) dans le chunk", async () => {
    let contenuInsere = "";
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRawUnsafe: vi.fn((_sql: string, ...params: unknown[]) => {
          contenuInsere = params[5] as string;
        }),
      })
    );
    const texteBrut = "Le   texte    brut avec des espaces multiples à nettoyer.";
    await indexerDecision({
      source: "OHADA",
      reference: "Arrêt n° 3/2026",
      juridiction: null,
      dateDecision: null,
      contenuBrut: texteBrut,
      lien: null,
    });
    expect(contenuInsere).not.toContain("   ");
    expect(contenuInsere).toContain("texte brut avec des espaces multiples à nettoyer");
  });
});
