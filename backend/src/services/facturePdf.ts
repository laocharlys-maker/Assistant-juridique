import PDFDocument from "pdfkit";
import { EnteteInput } from "./documentExport";
import { formatDateLongue } from "../utils/dateFormat";

export interface FactureInput {
  cabinetNom: string;
  numero: string;
  dateEmission: Date;
  dateEcheance: Date | null;
  nomClient: string;
  numeroDossier: string | null;
  nomAffaire: string | null;
  description: string;
  montant: number;
  appliquerTva: boolean;
  estProforma: boolean;
  entete?: EnteteInput;
}

const formatDate = formatDateLongue;

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
      const ENTETE_W = Math.min(260, usableWidth);
      const ENTETE_H = 70;
      const enteteX = doc.page.margins.left + (usableWidth - ENTETE_W) / 2;
      const enteteY = doc.y;
      doc.image(input.entete.buffer, enteteX, enteteY, { fit: [ENTETE_W, ENTETE_H] });
      doc.y = enteteY + ENTETE_H + 10;
    }

    doc.font("Helvetica-Bold").fontSize(16).text(input.cabinetNom, { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(13).text(input.estProforma ? "FACTURE PROFORMA" : "FACTURE", { align: "center" });
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(10);
    doc.text(`N° ${input.numero}`);
    doc.text(`Date d'émission : ${formatDate(input.dateEmission)}`);
    if (input.dateEcheance) {
      doc.text(`Échéance : ${formatDate(input.dateEcheance)}`);
    }
    doc.moveDown(0.8);
    doc.text(`Client : ${input.nomClient}`);
    if (input.numeroDossier && input.nomAffaire) {
      doc.text(`Dossier : ${input.numeroDossier} — ${input.nomAffaire}`);
    }
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

    if (input.appliquerTva) {
      const montantTva = Math.round(input.montant * 0.18);
      const montantTtc = input.montant + montantTva;
      doc.font("Helvetica").fontSize(10);
      doc.text(`Total HT : ${formatMontant(input.montant)}`, { align: "right" });
      doc.text(`TVA (18%) : ${formatMontant(montantTva)}`, { align: "right" });
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(12);
      doc.text(`Total TTC : ${formatMontant(montantTtc)}`, { align: "right" });
    } else {
      doc.font("Helvetica-Bold").fontSize(12);
      doc.text(`Total : ${formatMontant(input.montant)}`, { align: "right" });
    }
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
