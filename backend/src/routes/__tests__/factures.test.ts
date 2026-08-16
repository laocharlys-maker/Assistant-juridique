import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";

/**
 * Suivi comptable "Factures payées" : GET /api/factures/payees (filtre sur
 * statut existant, jamais une duplication de données) + les trois routes de
 * gestion du PDF de facture normalisée (SYGMEF) - attacher/consulter/retirer.
 * Prisma et le stockage chiffré sont mockés (voir factureNormaliseePdf.ts,
 * lui-même une passerelle fine vers stockageDocuments.ts déjà testé
 * ailleurs) - seul le comportement de ce routeur est vérifié ici.
 */

const prismaMock = vi.hoisted(() => ({
  facture: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("../../middleware/requireAuth", () => ({
  requireAuth: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: "user-1", cabinetId: "cabinet-1", role: "avocat" };
    next();
  },
}));
vi.mock("../../middleware/roles", () => ({
  requireAvocat: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../services/factureNormaliseePdf", () => ({
  stockerFactureNormalisee: vi.fn(),
  lireFactureNormalisee: vi.fn(),
  supprimerFactureNormalisee: vi.fn(),
}));
vi.mock("../../services/facturePdf", () => ({ buildFacturePdf: vi.fn() }));
vi.mock("../../services/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("../../services/cabinetContact", () => ({ resolveCabinetEmailIdentite: vi.fn() }));
vi.mock("../../services/feuillesTemps", () => ({ calculerMontant: vi.fn(), formatDuree: vi.fn() }));
vi.mock("../documentExport", () => ({ resolveEntete: vi.fn() }));

let server: Server;
let baseUrl: string;

async function api(path: string, options: { method?: string; body?: unknown } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: options.method,
    headers: { "Content-Type": "application/json" },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

beforeAll(async () => {
  const { facturesRouter } = await import("../factures");
  const app = express();
  app.use(express.json({ limit: "20mb" }));
  app.use(facturesRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server?.close();
});

function factureBase(overrides: Record<string, unknown> = {}) {
  return {
    id: "facture-1",
    cabinetId: "cabinet-1",
    numero: "FACT-2026-0001",
    statut: "payee",
    clientNom: "Client Test",
    montant: 100000,
    appliquerTva: false,
    payeeAt: new Date().toISOString(),
    factureNormaliseeNumero: null,
    factureNormaliseeDatePaiement: null,
    factureNormaliseeNomFichier: null,
    factureNormaliseeNomOriginal: null,
    ...overrides,
  };
}

describe("GET /api/factures/payees", () => {
  it("filtre sur statut=payee et cabinetId (jamais une duplication de données)", async () => {
    prismaMock.facture.findMany.mockResolvedValue([factureBase()]);
    const res = await api("/api/factures/payees");
    expect(res.status).toBe(200);
    expect(prismaMock.facture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cabinetId: "cabinet-1", statut: "payee" } })
    );
  });
});

const PDF_DATA_URL = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 contenu simulé").toString("base64")}`;

describe("POST /api/factures/:id/facture-normalisee", () => {
  it("refuse (400) si la facture n'est pas encore marquée payée", async () => {
    prismaMock.facture.findFirst.mockResolvedValue(factureBase({ statut: "envoyee" }));
    const res = await api("/api/factures/facture-1/facture-normalisee", {
      method: "POST",
      body: { datePaiement: "2026-08-16", fichierDataUrl: PDF_DATA_URL },
    });
    expect(res.status).toBe(400);
  });

  it("404 si la facture n'existe pas (ou appartient à un autre cabinet)", async () => {
    prismaMock.facture.findFirst.mockResolvedValue(null);
    const res = await api("/api/factures/facture-1/facture-normalisee", {
      method: "POST",
      body: { datePaiement: "2026-08-16", fichierDataUrl: PDF_DATA_URL },
    });
    expect(res.status).toBe(404);
  });

  it("415 si le fichier n'est pas un PDF", async () => {
    prismaMock.facture.findFirst.mockResolvedValue(factureBase());
    const res = await api("/api/factures/facture-1/facture-normalisee", {
      method: "POST",
      body: { datePaiement: "2026-08-16", fichierDataUrl: "data:image/png;base64,aGVsbG8=" },
    });
    expect(res.status).toBe(415);
  });

  it("enregistre le PDF (numéro facultatif) et met à jour la facture", async () => {
    const { stockerFactureNormalisee } = await import("../../services/factureNormaliseePdf");
    vi.mocked(stockerFactureNormalisee).mockResolvedValue({ nomFichier: "abc.enc", tailleOctets: 42 });
    prismaMock.facture.findFirst.mockResolvedValue(factureBase());
    prismaMock.facture.update.mockResolvedValue(factureBase({ factureNormaliseeNomFichier: "abc.enc" }));

    const res = await api("/api/factures/facture-1/facture-normalisee", {
      method: "POST",
      body: { datePaiement: "2026-08-16", fichierDataUrl: PDF_DATA_URL },
    });

    expect(res.status).toBe(201);
    expect(prismaMock.facture.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ factureNormaliseeNumero: null, factureNormaliseeNomFichier: "abc.enc" }),
      })
    );
  });

  it("accepte et transmet un numéro quand il est fourni", async () => {
    const { stockerFactureNormalisee } = await import("../../services/factureNormaliseePdf");
    vi.mocked(stockerFactureNormalisee).mockResolvedValue({ nomFichier: "abc.enc", tailleOctets: 42 });
    prismaMock.facture.findFirst.mockResolvedValue(factureBase());
    prismaMock.facture.update.mockResolvedValue(factureBase());

    await api("/api/factures/facture-1/facture-normalisee", {
      method: "POST",
      body: { numero: "SYGMEF-2026-0042", datePaiement: "2026-08-16", fichierDataUrl: PDF_DATA_URL },
    });

    expect(prismaMock.facture.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ factureNormaliseeNumero: "SYGMEF-2026-0042" }) })
    );
  });

  it("supprime l'ancien fichier avant d'enregistrer le nouveau (remplacement, jamais d'accumulation)", async () => {
    const { stockerFactureNormalisee, supprimerFactureNormalisee } = await import("../../services/factureNormaliseePdf");
    vi.mocked(stockerFactureNormalisee).mockResolvedValue({ nomFichier: "nouveau.enc", tailleOctets: 42 });
    vi.mocked(supprimerFactureNormalisee).mockResolvedValue(undefined);
    prismaMock.facture.findFirst.mockResolvedValue(factureBase({ factureNormaliseeNomFichier: "ancien.enc" }));
    prismaMock.facture.update.mockResolvedValue(factureBase());

    await api("/api/factures/facture-1/facture-normalisee", {
      method: "POST",
      body: { datePaiement: "2026-08-16", fichierDataUrl: PDF_DATA_URL },
    });

    expect(supprimerFactureNormalisee).toHaveBeenCalledWith("facture-1", "ancien.enc");
  });
});

describe("GET /api/factures/:id/facture-normalisee", () => {
  it("404 si aucun PDF n'est attaché", async () => {
    prismaMock.facture.findFirst.mockResolvedValue(factureBase({ factureNormaliseeNomFichier: null }));
    const res = await api("/api/factures/facture-1/facture-normalisee");
    expect(res.status).toBe(404);
  });

  it("renvoie le PDF déchiffré avec le bon type de contenu", async () => {
    const { lireFactureNormalisee } = await import("../../services/factureNormaliseePdf");
    vi.mocked(lireFactureNormalisee).mockResolvedValue(Buffer.from("%PDF-contenu"));
    prismaMock.facture.findFirst.mockResolvedValue(
      factureBase({ factureNormaliseeNomFichier: "abc.enc", factureNormaliseeNomOriginal: "facture-normalisee-FACT-2026-0001.pdf" })
    );

    const res = await api("/api/factures/facture-1/facture-normalisee");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });
});

describe("DELETE /api/factures/:id/facture-normalisee", () => {
  it("supprime le fichier stocké et réinitialise les champs", async () => {
    const { supprimerFactureNormalisee } = await import("../../services/factureNormaliseePdf");
    vi.mocked(supprimerFactureNormalisee).mockResolvedValue(undefined);
    prismaMock.facture.findFirst.mockResolvedValue(factureBase({ factureNormaliseeNomFichier: "abc.enc" }));
    prismaMock.facture.update.mockResolvedValue(factureBase());

    const res = await api("/api/factures/facture-1/facture-normalisee", { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(supprimerFactureNormalisee).toHaveBeenCalledWith("facture-1", "abc.enc");
    expect(prismaMock.facture.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ factureNormaliseeNomFichier: null, factureNormaliseeNumero: null }),
      })
    );
  });
});
