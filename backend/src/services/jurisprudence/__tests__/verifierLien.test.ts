import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const prismaMock = vi.hoisted(() => ({ jurisprudencePdf: { findUnique: vi.fn() } }));
vi.mock("../../../lib/prisma", () => ({ prisma: prismaMock }));

const pdfJurisprudenceExisteMock = vi.hoisted(() => vi.fn());
vi.mock("../stockagePdf", async () => {
  const reel = await vi.importActual<typeof import("../stockagePdf")>("../stockagePdf");
  return { ...reel, pdfJurisprudenceExiste: pdfJurisprudenceExisteMock };
});

import { verifierLien, verifierLiens, _viderCachePourTests } from "../verifierLien";

describe("verifierLien", () => {
  beforeEach(() => {
    _viderCachePourTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accessible : un statut 200 en HEAD suffit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const resultat = await verifierLien("https://exemple.test/decision/123");
    expect(resultat.accessible).toBe(true);
    expect(resultat.statut).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://exemple.test/decision/123", expect.objectContaining({ method: "HEAD" }));
  });

  it("inaccessible : un 404 n'est jamais affiché comme un lien valide", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404 }));
    const resultat = await verifierLien("https://exemple.test/introuvable");
    expect(resultat.accessible).toBe(false);
    expect(resultat.statut).toBe(404);
  });

  it("repli sur GET quand HEAD répond un statut non concluant (403)", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: { method: string }) => {
      if (opts.method === "HEAD") return Promise.resolve({ status: 403 });
      return Promise.resolve({ status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const resultat = await verifierLien("https://exemple.test/bloque-head");
    expect(resultat.accessible).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("repli sur GET quand HEAD échoue complètement (timeout/erreur réseau)", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, opts: { method: string }) => {
      if (opts.method === "HEAD") return Promise.reject(new Error("timeout"));
      return Promise.resolve({ status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const resultat = await verifierLien("https://exemple.test/head-echoue");
    expect(resultat.accessible).toBe(true);
  });

  it("erreur réseau persistante (HEAD et GET échouent) : inaccessible avec message d'erreur", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const resultat = await verifierLien("https://exemple.test/hors-ligne");
    expect(resultat.accessible).toBe(false);
    expect(resultat.erreur).toContain("ECONNREFUSED");
  });

  it("URL syntaxiquement invalide : rejetée sans aucune requête réseau", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const resultat = await verifierLien("pas-une-url");
    expect(resultat.accessible).toBe(false);
    expect(resultat.erreur).toContain("invalide");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("met en cache le résultat : un second appel sur la même URL ne refait pas de requête", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await verifierLien("https://exemple.test/cache");
    await verifierLien("https://exemple.test/cache");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("verifierLiens : vérifie plusieurs URLs en parallèle, dédupliquées", async () => {
    let appelsEnCours = 0;
    let maxParalleles = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      appelsEnCours++;
      maxParalleles = Math.max(maxParalleles, appelsEnCours);
      await new Promise((r) => setTimeout(r, 20));
      appelsEnCours--;
      return { status: 200 };
    });
    vi.stubGlobal("fetch", fetchMock);

    const resultats = await verifierLiens([
      "https://exemple.test/a",
      "https://exemple.test/b",
      "https://exemple.test/a", // doublon
    ]);

    expect(resultats.size).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2); // deduplique, pas 3
    expect(maxParalleles).toBeGreaterThan(1); // execute en parallele, pas en sequence
  });

  describe("lien interne (passerelle resume PDF -> jurisprudence)", () => {
    it("un lien interne vers un PDF existant est accessible SANS aucune requête HTTP sortante", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      prismaMock.jurisprudencePdf.findUnique.mockResolvedValue({ groupeId: "g1", nomFichier: "abc.enc" });
      pdfJurisprudenceExisteMock.mockResolvedValue(true);

      const resultat = await verifierLien("/api/jurisprudence-base/g1/document");

      expect(resultat.accessible).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(pdfJurisprudenceExisteMock).toHaveBeenCalledWith("abc.enc");
    });

    it("un lien interne dont le fichier a disparu du disque est inaccessible", async () => {
      prismaMock.jurisprudencePdf.findUnique.mockResolvedValue({ groupeId: "g2", nomFichier: "manquant.enc" });
      pdfJurisprudenceExisteMock.mockResolvedValue(false);

      const resultat = await verifierLien("/api/jurisprudence-base/g2/document");

      expect(resultat.accessible).toBe(false);
      expect(resultat.erreur).toContain("manquant");
    });

    it("un lien interne sans métadonnée en base (décision supprimée) est inaccessible", async () => {
      prismaMock.jurisprudencePdf.findUnique.mockResolvedValue(null);

      const resultat = await verifierLien("/api/jurisprudence-base/g-inexistant/document");

      expect(resultat.accessible).toBe(false);
      expect(pdfJurisprudenceExisteMock).not.toHaveBeenCalled();
    });
  });
});
