import { describe, it, expect, vi } from "vitest";

/**
 * pdf-parse est mocké : son bundle webpack interne (pdf.js v1.10.100, très
 * ancien) plante systématiquement sous Vitest ("bad XRef entry"), y compris
 * sur un PDF valide relu depuis le disque - confirmé en isolant le problème
 * (aucun rapport avec ce module ni avec pdfkit : reproductible avec pdf-parse
 * seul, sous Vitest uniquement, jamais en Node pur). Voir README-LOT17.md,
 * section tests. Ce mock permet en plus de tester précisément le seuil
 * (SEUIL_CARACTERES_PAR_PAGE), ce qu'un vrai PDF généré à la volée ne
 * permettrait pas de faire de façon aussi déterministe.
 */
const pdfParseMock = vi.hoisted(() => vi.fn());
vi.mock("pdf-parse", () => ({ default: pdfParseMock }));

import { detecterBesoinOcr, SEUIL_CARACTERES_PAR_PAGE } from "../detectionScanne";

describe("detecterBesoinOcr", () => {
  it("une image JPEG necessite toujours l'OCR, sans jamais appeler pdf-parse", async () => {
    const resultat = await detecterBesoinOcr("image/jpeg", Buffer.from("donnees-image"));
    expect(resultat.necessiteOcr).toBe(true);
    expect(pdfParseMock).not.toHaveBeenCalled();
  });

  it("une image PNG necessite toujours l'OCR", async () => {
    const resultat = await detecterBesoinOcr("image/png", Buffer.from("donnees-image"));
    expect(resultat.necessiteOcr).toBe(true);
  });

  it("un format hors périmètre OCR V1 (Word, texte brut, GIF, WEBP...) ne déclenche jamais l'OCR, sans appeler pdf-parse", async () => {
    const resultat = await detecterBesoinOcr("application/msword", Buffer.from("peu importe"));
    expect(resultat.necessiteOcr).toBe(false);
    expect(resultat.texteNatif).toBe("");
    expect(pdfParseMock).not.toHaveBeenCalled();
  });

  it("un PDF avec du texte natif suffisant (au-dessus du seuil, 2 pages) ne nécessite pas l'OCR", async () => {
    pdfParseMock.mockResolvedValue({ text: "a".repeat(SEUIL_CARACTERES_PAR_PAGE * 2 + 10), numpages: 2 });

    const resultat = await detecterBesoinOcr("application/pdf", Buffer.from("pdf"));

    expect(resultat.necessiteOcr).toBe(false);
    expect(resultat.nombrePages).toBe(2);
  });

  it("un PDF quasiment vide (scanné, sans couche texte) nécessite l'OCR", async () => {
    pdfParseMock.mockResolvedValue({ text: "   ", numpages: 1 });

    const resultat = await detecterBesoinOcr("application/pdf", Buffer.from("pdf"));

    expect(resultat.necessiteOcr).toBe(true);
  });

  it("juste sous le seuil (par page) : nécessite l'OCR", async () => {
    pdfParseMock.mockResolvedValue({ text: "a".repeat(SEUIL_CARACTERES_PAR_PAGE - 1), numpages: 1 });

    const resultat = await detecterBesoinOcr("application/pdf", Buffer.from("pdf"));

    expect(resultat.necessiteOcr).toBe(true);
  });

  it("juste au-dessus du seuil (par page) : ne nécessite pas l'OCR", async () => {
    pdfParseMock.mockResolvedValue({ text: "a".repeat(SEUIL_CARACTERES_PAR_PAGE + 1), numpages: 1 });

    const resultat = await detecterBesoinOcr("application/pdf", Buffer.from("pdf"));

    expect(resultat.necessiteOcr).toBe(false);
  });

  it("un PDF illisible par pdf-parse (corrompu/protégé) est traité comme nécessitant l'OCR, par prudence", async () => {
    pdfParseMock.mockRejectedValue(new Error("bad XRef entry"));

    const resultat = await detecterBesoinOcr("application/pdf", Buffer.from("pas un vrai pdf"));

    expect(resultat.necessiteOcr).toBe(true);
  });
});
