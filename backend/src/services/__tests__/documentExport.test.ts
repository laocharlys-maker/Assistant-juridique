import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildDocx, buildPdf, ExportInput } from "../documentExport";

const MARKDOWN_SAMPLE = [
  "## Conditions de fond",
  "",
  "Le droit foncier repose sur plusieurs conditions :",
  "",
  "- Le titre foncier confirme aupres de l'ANDF",
  "- Un objet et une cause **licites**",
  "",
  "## Comparaison",
  "",
  "| Critere | Zone urbaine | Zone rurale |",
  "| --- | --- | --- |",
  "| Acces etranger | Sous condition | Interdit |",
  "",
  "Un paragraphe normal apres le tableau.",
].join("\n");

const BASE_INPUT: ExportInput = {
  cabinetNom: "Koffi & Diabate",
  numeroDossier: "JURIS-001",
  nomAffaire: "Test export",
  typeLabel: "Recherche de jurisprudence",
  contenu: MARKDOWN_SAMPLE,
  auteurNom: "Maître Koffi",
  date: new Date("2026-07-28"),
};

// Note sur buildPdf : on ne peut pas verifier automatiquement le texte
// extrait d'un PDF ici - la librairie "pdf-parse" du projet embarque une
// tres vieille version de pdf.js qui echoue ("bad XRef entry") meme sur un
// PDF pdfkit minimal ("Hello world", sans rapport avec ce fichier), donc ce
// n'est pas un defaut du PDF genere. On se limite a verifier que buildPdf
// ne plante pas et produit un fichier PDF valide en-tete/structure ; le
// contenu textuel du PDF a ete verifie manuellement par telechargement reel
// (le parseur Markdown est le meme que celui teste via buildDocx ci-dessous).
describe("buildDocx", () => {
  it("ne laisse aucune syntaxe Markdown brute dans le document genere", async () => {
    const buffer = await buildDocx(BASE_INPUT);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");

    expect(xml).not.toContain("##");
    expect(xml).not.toContain("**");
    expect(xml).not.toContain("| ---");
    expect(xml).not.toContain("|---");
  });

  it("conserve le texte reel (titres, listes, tableau) dans le document", async () => {
    const buffer = await buildDocx(BASE_INPUT);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");

    expect(xml).toContain("Conditions de fond");
    expect(xml).toContain("ANDF");
    expect(xml).toContain("licites");
    expect(xml).toContain("Zone urbaine");
    expect(xml).toContain("Interdit");
  });

  it("produit un vrai tableau Word (element w:tbl), pas du texte", async () => {
    const buffer = await buildDocx(BASE_INPUT);
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("<w:tbl>");
  });

  it("garde la detection des titres en MAJUSCULES pour les actes classiques (pas de Markdown)", async () => {
    const buffer = await buildDocx({
      ...BASE_INPUT,
      contenu: "PAR CES MOTIFS\n\nLe tribunal est prie de condamner la partie adverse.",
    });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("PAR CES MOTIFS");
    expect(xml).toContain("condamner");
  });
});

describe("buildPdf", () => {
  it("genere un fichier PDF valide sans erreur, pour du contenu Markdown", async () => {
    const buffer = await buildPdf(BASE_INPUT);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("genere un fichier PDF valide sans erreur, pour un tableau a plusieurs lignes", async () => {
    const buffer = await buildPdf({
      ...BASE_INPUT,
      contenu:
        MARKDOWN_SAMPLE +
        "\n\n| Origine | Reference |\n| --- | --- |\n| Benin | CCJA 001 |\n| OHADA | Acte uniforme |",
    });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("genere un fichier PDF valide sans erreur, pour un acte classique (pas de Markdown)", async () => {
    const buffer = await buildPdf({
      ...BASE_INPUT,
      contenu: "PAR CES MOTIFS\n\nLe tribunal est prie de condamner la partie adverse.",
    });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(500);
  });
});
