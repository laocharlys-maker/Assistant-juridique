import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from "docx";
import PDFDocument from "pdfkit";

export interface ExportInput {
  cabinetNom: string;
  numeroDossier: string;
  nomAffaire: string;
  typeLabel: string;
  contenu: string;
  auteurNom: string;
  date: Date;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });
}

export async function buildDocx(input: ExportInput): Promise<Buffer> {
  const paragraphesContenu = input.contenu
    .split(/\n+/)
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        new Paragraph({
          children: [new TextRun(line.trim())],
          spacing: { after: 200 },
        })
    );

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: input.cabinetNom,
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            children: [new TextRun({ text: input.typeLabel, bold: true })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 100 },
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: `Dossier ${input.numeroDossier} — ${input.nomAffaire}`,
                italics: true,
              }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 100 },
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `Rédigé par ${input.auteurNom} — ${formatDate(input.date)}`, size: 18 }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
          }),
          ...paragraphesContenu,
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

export async function buildPdf(input: ExportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(input.cabinetNom, { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(11).text(input.typeLabel, { align: "center" });
    doc.moveDown(0.2);
    doc
      .font("Helvetica-Oblique")
      .fontSize(10)
      .text(`Dossier ${input.numeroDossier} — ${input.nomAffaire}`, { align: "center" });
    doc.moveDown(0.2);
    doc
      .font("Helvetica")
      .fontSize(9)
      .text(`Rédigé par ${input.auteurNom} — ${formatDate(input.date)}`, { align: "center" });
    doc.moveDown(1.2);

    doc.font("Helvetica").fontSize(11);
    const paragraphes = input.contenu.split(/\n+/).filter((line) => line.trim().length > 0);
    for (const paragraphe of paragraphes) {
      doc.text(paragraphe.trim(), { align: "justify" });
      doc.moveDown(0.6);
    }

    doc.end();
  });
}
