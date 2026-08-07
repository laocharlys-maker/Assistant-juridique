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

  // Lot 11 (Partie B) : un document en mode redaction libre a un typeAction
  // reel mais champsDocument vide (aucun formulaire rempli) - ne doit pas
  // planter, ni afficher de placeholder incoherent type "undefined".
  it("n'affiche aucun placeholder incoherent quand typeAction est defini mais champsDocument absent (redaction libre)", async () => {
    const buffer = await buildDocx({
      ...BASE_INPUT,
      typeAction: "mise_en_demeure",
      champsDocument: null,
      contenu: "Maître,\n\nVeuillez agréer mes salutations distinguées.",
    });
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain("Maître");
    expect(xml).not.toContain("undefined");
    expect(xml).not.toContain("null");
  });
});

// Lot 11 (Partie C) : mention d'avertissement rappelant que toute
// modification doit etre reportee dans Aurore - jamais une garantie
// technique, une simple mesure d'attenuation par la clarte.
describe("mention d'avertissement (Lot 11, Partie C)", () => {
  it("buildDocx : affiche la mention 'non definitif' quand le document n'est pas encore valide", async () => {
    const buffer = await buildDocx({ ...BASE_INPUT, statut: "en_attente_validation" });
    const zip = await JSZip.loadAsync(buffer);
    const footer = await zip.file("word/footer1.xml")!.async("string");
    expect(footer).toContain("Document en cours de validation");
    expect(footer).toContain("non définitif");
    expect(footer).toContain("généré par Aurore le");
  });

  it("buildDocx : n'affiche pas 'non definitif' une fois le document valide", async () => {
    const buffer = await buildDocx({ ...BASE_INPUT, statut: "valide" });
    const zip = await JSZip.loadAsync(buffer);
    const footer = await zip.file("word/footer1.xml")!.async("string");
    expect(footer).not.toContain("non définitif");
    expect(footer).toContain("généré par Aurore le");
  });

  it("buildDocx : meme mention 'non definitif' quand le statut n'est pas fourni (par defaut, non valide)", async () => {
    const buffer = await buildDocx({ ...BASE_INPUT, statut: undefined });
    const zip = await JSZip.loadAsync(buffer);
    const footer = await zip.file("word/footer1.xml")!.async("string");
    expect(footer).toContain("non définitif");
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

  // Lot 11 (Partie C) : meme limite que la note en tete de fichier - le
  // texte du PDF (flux compresses) n'est pas extractible simplement ici, on
  // verifie seulement que l'ajout de la mention (statut valide/non valide)
  // ne fait planter ni buildPdf ni la generation du fichier - le contenu
  // exact de la mention est verifie cote Word ci-dessus (meme fonction
  // buildMentionAvertissement partagee par les deux formats).
  it("genere un fichier PDF valide sans erreur, avec la mention pour un document non valide", async () => {
    const buffer = await buildPdf({ ...BASE_INPUT, statut: "en_attente_validation" });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("genere un fichier PDF valide sans erreur, avec la mention pour un document valide", async () => {
    const buffer = await buildPdf({ ...BASE_INPUT, statut: "valide" });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("genere un fichier PDF valide sans erreur quand typeAction est defini mais champsDocument absent (redaction libre)", async () => {
    const buffer = await buildPdf({
      ...BASE_INPUT,
      typeAction: "mise_en_demeure",
      champsDocument: null,
      contenu: "Maître,\n\nVeuillez agréer mes salutations distinguées.",
    });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(buffer.length).toBeGreaterThan(500);
  });
});
