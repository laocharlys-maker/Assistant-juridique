import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";

/**
 * Lot 17 (suite) - export du texte reconnu (OCR) d'une piece en Word/PDF,
 * a la demande de l'avocat ("pouvoir emmener" le texte hors de l'appli.
 * Volontairement SANS le formalisme juridique de services/documentExport.ts
 * (entete/signature/bloc "Fait a... le...", identite des parties...) : un
 * texte OCR n'est pas un acte redige par le cabinet, seulement le contenu
 * brut reconnu sur une piece deja existante - lui appliquer une mise en
 * forme d'acte juridique serait trompeur. Document volontairement simple :
 * titre (nom de la piece), score de confiance, texte brut.
 */
export interface OcrTexteExportInput {
  cabinetNom: string;
  nomOriginal: string;
  scoreConfiance: number | null;
  texteExtrait: string;
}

/** Seuil identique a OCR_SEUIL_CONFIANCE_AVERTISSEMENT (public/dossier.html)
 * - a garder synchronise si ce seuil est ajuste un jour. */
const SEUIL_CONFIANCE_AVERTISSEMENT = 70;

function ligneMeta(input: OcrTexteExportInput): string {
  if (input.scoreConfiance === null) return "Score de confiance indisponible.";
  const score = Math.round(input.scoreConfiance);
  const avertissement = score < SEUIL_CONFIANCE_AVERTISSEMENT ? " — ⚠ relecture manuelle recommandée" : "";
  return `Score de confiance : ${score}%${avertissement}`;
}

export async function buildOcrTextePdf(input: OcrTexteExportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(14).text(input.cabinetNom, { align: "center" });
    doc.moveDown(0.8);
    doc.font("Helvetica-Bold").fontSize(13).text(`Texte reconnu — ${input.nomOriginal}`);
    doc.font("Helvetica").fontSize(9).fillColor("#666666").text(ligneMeta(input));
    doc.fillColor("#000000");
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(11).text(input.texteExtrait || "(aucun texte reconnu)", {
      align: "left",
      lineGap: 3,
    });

    doc.end();
  });
}

export async function buildOcrTexteWord(input: OcrTexteExportInput): Promise<Buffer> {
  const paragraphesTexte = (input.texteExtrait || "(aucun texte reconnu)")
    .split(/\n/)
    .map((ligne) => new Paragraph({ children: [new TextRun({ text: ligne, size: 22 })], spacing: { after: 120 } }));

  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: input.cabinetNom, bold: true, size: 28 })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
          }),
          new Paragraph({
            children: [new TextRun({ text: `Texte reconnu — ${input.nomOriginal}`, bold: true, size: 26 })],
            spacing: { after: 60 },
          }),
          new Paragraph({
            children: [new TextRun({ text: ligneMeta(input), size: 18, color: "666666" })],
            spacing: { after: 240 },
          }),
          ...paragraphesTexte,
        ],
      },
    ],
  });

  return Packer.toBuffer(document);
}
