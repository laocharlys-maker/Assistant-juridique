import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { prismaMock, lireFichierMock, detecterBesoinOcrMock, traiterDocumentOcrMock } = vi.hoisted(() => ({
  prismaMock: {
    ocrResultat: { upsert: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    documentDossier: { findUnique: vi.fn() },
  },
  lireFichierMock: vi.fn(),
  detecterBesoinOcrMock: vi.fn(),
  traiterDocumentOcrMock: vi.fn(),
}));

vi.mock("../../lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("../../services/stockageDocuments", () => ({ lireFichier: lireFichierMock }));
vi.mock("../../services/ocr/detectionScanne", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../../services/ocr/detectionScanne")>();
  return { ...reel, detecterBesoinOcr: detecterBesoinOcrMock };
});
// OcrEngineError reste la VRAIE classe (import original conservé) : le code
// testé fait `error instanceof OcrEngineError` - un mock naïf casserait ce
// contrôle et ferait passer tous les échecs pour des erreurs génériques.
vi.mock("../../services/ocr/moteurTesseract", async (importOriginal) => {
  const reel = await importOriginal<typeof import("../../services/ocr/moteurTesseract")>();
  return { ...reel, traiterDocumentOcr: traiterDocumentOcrMock };
});

/**
 * Lot 17 - orchestration OCR (jobs/traitementOcr.ts). encryptField/
 * decryptField (security/encryptionAtRest.ts) ne sont PAS mockés : ce test
 * vérifie une vraie encryption/déchiffrement, avec une clé dédiée générée
 * dans un %APPDATA% temporaire (jamais le vrai profil utilisateur - même
 * convention que stockageDocuments.test.ts).
 */
describe("traitementOcr", () => {
  let fakeAppData: string;
  let enqueuerTraitementOcr: typeof import("../traitementOcr").enqueuerTraitementOcr;
  let relancerOcr: typeof import("../traitementOcr").relancerOcr;
  let runOcrCycleDeSecours: typeof import("../traitementOcr").runOcrCycleDeSecours;
  let OcrEngineError: typeof import("../../services/ocr/moteurTesseract").OcrEngineError;

  beforeAll(async () => {
    fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), "aurore-test-ocr-job-"));
    process.env.APPDATA = fakeAppData;
    ({ enqueuerTraitementOcr, relancerOcr, runOcrCycleDeSecours } = await import("../traitementOcr"));
    ({ OcrEngineError } = await import("../../services/ocr/moteurTesseract"));
  });

  afterAll(() => {
    fs.rmSync(fakeAppData, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.ocrResultat.upsert.mockResolvedValue({ id: "ocr1" });
    prismaMock.ocrResultat.update.mockResolvedValue({});
  });

  const document = {
    id: "doc1",
    cabinetId: "cab1",
    dossierId: "dos1",
    nomFichier: "fichier.enc",
    typeMime: "image/jpeg",
  } as import("@prisma/client").DocumentDossier;

  describe("enqueuerTraitementOcr", () => {
    it("ne crée aucun OcrResultat pour un format hors périmètre OCR (Word...)", async () => {
      await enqueuerTraitementOcr({ ...document, typeMime: "application/msword" }, Buffer.from("x"));

      expect(detecterBesoinOcrMock).not.toHaveBeenCalled();
      expect(prismaMock.ocrResultat.upsert).not.toHaveBeenCalled();
    });

    it("ne crée aucun OcrResultat pour un PDF à texte natif suffisant", async () => {
      detecterBesoinOcrMock.mockResolvedValue({ necessiteOcr: false, texteNatif: "beaucoup de texte", nombrePages: 2 });

      await enqueuerTraitementOcr({ ...document, typeMime: "application/pdf" }, Buffer.from("x"));

      expect(prismaMock.ocrResultat.upsert).not.toHaveBeenCalled();
    });

    it("traite une image et chiffre le texte extrait avant écriture en base", async () => {
      detecterBesoinOcrMock.mockResolvedValue({ necessiteOcr: true, texteNatif: "", nombrePages: 1 });
      traiterDocumentOcrMock.mockResolvedValue({ texte: "Contrat entre Jean Kokou et Marie N'Da", scoreConfiance: 88 });

      await enqueuerTraitementOcr(document, Buffer.from("image-binaire"));

      expect(prismaMock.ocrResultat.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { documentId: "doc1" } })
      );
      // Premiere mise a jour : passage a "en_cours".
      expect(prismaMock.ocrResultat.update).toHaveBeenCalledWith({ where: { id: "ocr1" }, data: { statut: "en_cours" } });

      // Deuxieme mise a jour : "termine", texte JAMAIS en clair.
      const appelTermine = prismaMock.ocrResultat.update.mock.calls.find(
        (appel: unknown[]) => (appel[0] as { data: { statut?: string } }).data.statut === "termine"
      );
      expect(appelTermine).toBeDefined();
      const donnees = (appelTermine![0] as { data: { texteExtrait: string; scoreConfiance: number } }).data;
      expect(donnees.scoreConfiance).toBe(88);
      expect(donnees.texteExtrait).toMatch(/^enc:v1:/);
      expect(donnees.texteExtrait).not.toContain("Jean Kokou");
    });

    it("statut 'echec' avec un message clair si le moteur OCR échoue", async () => {
      detecterBesoinOcrMock.mockResolvedValue({ necessiteOcr: true, texteNatif: "", nombrePages: 1 });
      traiterDocumentOcrMock.mockRejectedValue(new OcrEngineError("La reconnaissance de texte a échoué sur ce document."));

      await enqueuerTraitementOcr(document, Buffer.from("image-binaire"));

      const appelEchec = prismaMock.ocrResultat.update.mock.calls.find(
        (appel: unknown[]) => (appel[0] as { data: { statut?: string } }).data.statut === "echec"
      );
      expect(appelEchec).toBeDefined();
      const donnees = (appelEchec![0] as { data: { messageErreur: string; texteExtrait: unknown } }).data;
      expect(donnees.messageErreur).toBe("La reconnaissance de texte a échoué sur ce document.");
      expect(donnees.texteExtrait).toBeNull();
    });

    it("ne rejette jamais, même si prisma échoue (hook additif, ne doit jamais faire échouer l'upload)", async () => {
      detecterBesoinOcrMock.mockResolvedValue({ necessiteOcr: true, texteNatif: "", nombrePages: 1 });
      prismaMock.ocrResultat.upsert.mockRejectedValue(new Error("DB down"));

      await expect(enqueuerTraitementOcr(document, Buffer.from("x"))).resolves.toBeUndefined();
    });
  });

  describe("relancerOcr", () => {
    it("renvoie une erreur claire si le document est introuvable", async () => {
      prismaMock.documentDossier.findUnique.mockResolvedValue(null);

      const resultat = await relancerOcr("doc-inconnu");

      expect(resultat).toEqual({ ok: false, error: "Document introuvable." });
    });

    it("renvoie une erreur claire pour un format non pris en charge, sans jamais toucher au moteur OCR", async () => {
      prismaMock.documentDossier.findUnique.mockResolvedValue({ ...document, typeMime: "application/msword" });

      const resultat = await relancerOcr("doc1");

      expect(resultat.ok).toBe(false);
      if (!resultat.ok) expect(resultat.error).toContain("pas pris en charge");
      expect(prismaMock.ocrResultat.upsert).not.toHaveBeenCalled();
      expect(traiterDocumentOcrMock).not.toHaveBeenCalled();
    });

    it("relance en tâche de fond : répond avant la fin du (nouveau) traitement", async () => {
      prismaMock.documentDossier.findUnique.mockResolvedValue(document);
      lireFichierMock.mockResolvedValue(Buffer.from("image-binaire"));
      let resoudreTraitement!: (v: { texte: string; scoreConfiance: number }) => void;
      traiterDocumentOcrMock.mockReturnValue(new Promise((resolve) => (resoudreTraitement = resolve)));

      const resultat = await relancerOcr("doc1");

      expect(resultat).toEqual({ ok: true });
      // Le traitement n'est pas encore termine (promesse volontairement en
      // attente) : seule la ligne "en_attente" a ete ecrite pour l'instant.
      expect(prismaMock.ocrResultat.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ statut: "termine" }) })
      );

      resoudreTraitement({ texte: "texte relance", scoreConfiance: 60 });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      expect(prismaMock.ocrResultat.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ statut: "termine" }) })
      );
    });
  });

  describe("runOcrCycleDeSecours", () => {
    it("reprend un traitement resté bloqué (en_attente/en_cours) et le termine", async () => {
      prismaMock.ocrResultat.findMany.mockResolvedValue([
        { id: "ocr-bloque", statut: "en_attente", document: { ...document, id: "doc-bloque" } },
      ]);
      lireFichierMock.mockResolvedValue(Buffer.from("image-binaire"));
      traiterDocumentOcrMock.mockResolvedValue({ texte: "texte rattrape", scoreConfiance: 75 });

      await runOcrCycleDeSecours();

      expect(lireFichierMock).toHaveBeenCalledWith(document.dossierId, document.nomFichier);
      expect(prismaMock.ocrResultat.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ocr-bloque" }, data: expect.objectContaining({ statut: "termine" }) })
      );
    });

    it("passe en 'echec' avec un message clair si le fichier original est illisible, sans planter le cycle", async () => {
      prismaMock.ocrResultat.findMany.mockResolvedValue([
        { id: "ocr-bloque", statut: "en_cours", document: { ...document, id: "doc-bloque" } },
      ]);
      lireFichierMock.mockRejectedValue(new Error("fichier manquant sur disque"));

      await expect(runOcrCycleDeSecours()).resolves.toBeUndefined();

      expect(prismaMock.ocrResultat.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ocr-bloque" }, data: expect.objectContaining({ statut: "echec" }) })
      );
    });
  });

  it("n'importe jamais services/llm (aucun appel LLM sur le texte OCR)", () => {
    // Ne cherche que de vraies specifications d'import/require - un
    // commentaire mentionnant "services/llm" en toutes lettres (pour
    // expliquer justement cette contrainte) ne doit pas faire echouer ce
    // test, seul un import reel doit le faire.
    const patternImport = /(?:from\s+|require\()\s*["'][^"']*services\/llm[^"']*["']/;
    const fichiers = [
      path.join(__dirname, "../traitementOcr.ts"),
      path.join(__dirname, "../../services/ocr/moteurTesseract.ts"),
      path.join(__dirname, "../../services/ocr/detectionScanne.ts"),
    ];
    for (const fichier of fichiers) {
      const source = fs.readFileSync(fichier, "utf8");
      expect(source).not.toMatch(patternImport);
    }
  });
});
