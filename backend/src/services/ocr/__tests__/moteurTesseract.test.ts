import { describe, it, expect } from "vitest";
import { traiterDocumentOcr, OcrEngineError } from "../moteurTesseract";

/**
 * Le chemin heureux (image/PDF -> Tesseract) necessite un vrai moteur OCR
 * (tesseract.js, pack de langue telecharge au premier lancement) - non
 * couvert ici par choix (lent, dependant du reseau au premier appel, voir
 * README-LOT17.md). Ce test couvre le rejet immediat d'un format non pris
 * en charge, qui ne demarre jamais le moteur (donc rapide et deterministe).
 */
describe("traiterDocumentOcr", () => {
  it("rejette immédiatement un type de fichier non pris en charge, sans jamais démarrer le moteur OCR", async () => {
    await expect(traiterDocumentOcr("application/msword", Buffer.from("peu importe"))).rejects.toBeInstanceOf(
      OcrEngineError
    );
    await expect(traiterDocumentOcr("application/msword", Buffer.from("peu importe"))).rejects.toThrow(
      /non pris en charge/
    );
  });

  it("le message d'erreur reste clair, sans jargon technique", async () => {
    try {
      await traiterDocumentOcr("text/plain", Buffer.from("x"));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OcrEngineError);
      expect((error as Error).message).toContain("JPEG, PNG, PDF");
    }
  });
});
