import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildDocx, buildPdf, ExportInput, readImageDimensions, fitDocxImage } from "../documentExport";

// Construit un faux PNG structurellement plausible (signature + chunk IHDR
// avec des dimensions connues) - suffisant pour readImageDimensions, qui ne
// lit que ces octets fixes et ne valide jamais le CRC ni le reste du fichier
// (jamais besoin d'un vrai decodeur PNG pour ce seul besoin : mesurer la
// largeur/hauteur declarees).
function fakePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature PNG
  buffer.writeUInt32BE(13, 8); // longueur du chunk IHDR (non lue par readImageDimensions)
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

// Construit un faux JPEG minimal : SOI + un marqueur SOF0 (0xFFC0) portant
// les dimensions reelles - meme principe que fakePng ci-dessus.
function fakeJpeg(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(19);
  buffer.set([0xff, 0xd8], 0); // SOI
  buffer.set([0xff, 0xc0], 2); // marqueur SOF0
  buffer.writeUInt16BE(11, 4); // longueur du segment
  buffer[6] = 8; // precision
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe("readImageDimensions", () => {
  it("lit les dimensions reelles d'un PNG", () => {
    expect(readImageDimensions(fakePng(450, 121), "png")).toEqual({ width: 450, height: 121 });
    expect(readImageDimensions(fakePng(800, 200), "png")).toEqual({ width: 800, height: 200 });
  });

  it("lit les dimensions reelles d'un JPEG", () => {
    expect(readImageDimensions(fakeJpeg(600, 300), "jpg")).toEqual({ width: 600, height: 300 });
  });

  it("renvoie null pour des octets qui ne sont pas un PNG valide (signature absente)", () => {
    expect(readImageDimensions(Buffer.alloc(24), "png")).toBeNull();
  });
});

describe("fitDocxImage - preserve le ratio reel (jamais de deformation)", () => {
  it("une signature plus large que haute (ratio tres different de la boite) n'est jamais aplatie", () => {
    // Boite historique 150x60 (ratio 2.5:1) - une signature scannee 900x120
    // (ratio 7.5:1) etait avant ce correctif etiree en 150x60, l'aplatissant
    // visuellement (constate par l'utilisateur a l'export Word).
    const { width, height } = fitDocxImage(fakePng(900, 120), "png", 150, 60);
    expect(width / height).toBeCloseTo(900 / 120, 5);
    expect(width).toBeLessThanOrEqual(150);
    expect(height).toBeLessThanOrEqual(60);
  });

  it("une image carree reste carree", () => {
    const { width, height } = fitDocxImage(fakePng(400, 400), "png", 450, 121);
    expect(width).toBe(height);
  });

  it("se replie sur la boite complete si les dimensions n'ont pas pu etre lues", () => {
    expect(fitDocxImage(Buffer.alloc(4), "png", 150, 60)).toEqual({ width: 150, height: 60 });
  });
});

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

// La mention d'avertissement (Lot 11, Partie C) a ete retiree sur demande
// explicite : aucun pied de page ne doit plus apparaitre sur les exports
// Word/PDF, quel que soit le statut du document.
describe("pied de page", () => {
  it("buildDocx : n'ajoute aucun pied de page", async () => {
    const buffer = await buildDocx(BASE_INPUT);
    const zip = await JSZip.loadAsync(buffer);
    expect(zip.file("word/footer1.xml")).toBeNull();
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
