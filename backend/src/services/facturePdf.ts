import PDFDocument from "pdfkit";
import { EnteteInput } from "./documentExport";

export interface FactureInput {
  cabinetNom: string;
  numero: string;
  dateEmission: Date;
  dateEcheance: Date | null;
  nomClient: string;
  numeroDossier: string;
  nomAffaire: string;
  description: string;
  montant: number;
  entete?: EnteteInput;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });
}

function formatMontant(montant: number): string {
  return `${montant.toLocaleString("fr-FR")} F CFA`;
}

export async function buildFacturePdf(input: FactureInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (input.entete) {
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const enteteWidth = 260;
      doc.image(input.entete.buffer, doc.page.margins.left + (usableWidth - enteteWidth) / 2, doc.y, {
        width: enteteWidth,
      });
      doc.moveDown(3.5);
    }

    doc.font("Helvetica-Bold").fontSize(16).text(input.cabinetNom, { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(13).text("FACTURE", { align: "center" });
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(10);
    doc.text(`N° ${input.numero}`);
    doc.text(`Date d'émission : ${formatDate(input.dateEmission)}`);
    if (input.dateEcheance) {
      doc.text(`Échéance : ${formatDate(input.dateEcheance)}`);
    }
    doc.moveDown(0.8);
    doc.text(`Client : ${input.nomClient}`);
    doc.text(`Dossier : ${input.numeroDossier} — ${input.nomAffaire}`);
    doc.moveDown(1.2);

    const tableTop = doc.y;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const montantColWidth = 120;
    const descColWidth = usableWidth - montantColWidth;

    doc.font("Helvetica-Bold").fontSize(10);
    doc.text("Description", doc.page.margins.left, tableTop, { width: descColWidth });
    doc.text("Montant", doc.page.margins.left + descColWidth, tableTop, {
      width: montantColWidth,
      align: "right",
    });
    doc.moveDown(0.3);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.margins.left + usableWidth, doc.y)
      .stroke();
    doc.moveDown(0.5);

    const rowTop = doc.y;
    doc.font("Helvetica").fontSize(10);
    doc.text(input.description, doc.page.margins.left, rowTop, { width: descColWidth });
    const descHeight = doc.heightOfString(input.description, { width: descColWidth });
    doc.text(formatMontant(input.montant), doc.page.margins.left + descColWidth, rowTop, {
      width: montantColWidth,
      align: "right",
    });
    doc.y = rowTop + Math.max(descHeight, 14);
    doc.moveDown(0.5);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.margins.left + usableWidth, doc.y)
      .stroke();
    doc.moveDown(0.8);

    doc.font("Helvetica-Bold").fontSize(12);
    doc.text(`Total : ${formatMontant(input.montant)}`, { align: "right" });
    doc.moveDown(2);

    doc
      .font("Helvetica-Oblique")
      .fontSize(8)
      .fillColor("#6b6a64")
      .text(
        "Document interne de suivi des honoraires. Ne tient pas lieu de facture normalisée au sens fiscal (SYGMEF) — celle-ci est émise séparément par l'avocat.",
        { align: "center" }
      );

    doc.end();
  });
}
