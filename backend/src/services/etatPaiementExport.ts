import PDFDocument from "pdfkit";

/**
 * Module RH Cabinet, RH-6 (voir docs/rh/) - exports de l'etat de paiement
 * mensuel. Decision du 13/10/2026 (docs/rh/00-audit.md, question 4) : PDF
 * + CSV uniquement en V1, pas de dependance Excel (exceljs) - un CSV
 * s'ouvre nativement dans Excel.
 */
export interface LigneEtatInput {
  nomEmploye: string;
  brut: number;
  totalRetenues: number;
  net: number;
  modePaiement: string | null;
  statutPaiement: "a_payer" | "paye";
}

export interface EtatPaiementInput {
  cabinetNom: string;
  mois: string;
  lignes: LigneEtatInput[];
  totalBrut: number;
  totalRetenues: number;
  totalNet: number;
}

const MODE_LABELS: Record<string, string> = { virement: "Virement", especes: "Espèces", mobile_money: "Mobile Money" };
const STATUT_LABELS: Record<string, string> = { a_payer: "À payer", paye: "Payé" };

const MOIS_LABELS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function formatMois(mois: string): string {
  const [annee, moisNum] = mois.split("-").map(Number);
  return `${MOIS_LABELS[moisNum - 1]} ${annee}`;
}

function formatMontant(montant: number): string {
  return `${Math.round(montant).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} F CFA`;
}

// Separateur point-virgule (pas virgule) : en locale francaise, Excel
// utilise deja la virgule comme separateur decimal - un CSV virgule y
// ouvrirait tout dans une seule colonne. BOM UTF-8 en tete pour que les
// caracteres accentues s'affichent correctement a l'ouverture.
export function buildEtatPaiementCsv(input: EtatPaiementInput): string {
  const BOM = "﻿";
  const entete = ["Employé", "Brut (F CFA)", "Retenues (F CFA)", "Net (F CFA)", "Mode de paiement", "Statut"].join(";");
  const lignes = input.lignes.map((l) =>
    [l.nomEmploye, Math.round(l.brut), Math.round(l.totalRetenues), Math.round(l.net), l.modePaiement ? MODE_LABELS[l.modePaiement] || l.modePaiement : "", STATUT_LABELS[l.statutPaiement]]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(";")
  );
  const totaux = ["TOTAL", Math.round(input.totalBrut), Math.round(input.totalRetenues), Math.round(input.totalNet), "", ""].join(";");
  return BOM + [entete, ...lignes, totaux].join("\r\n");
}

export async function buildEtatPaiementPdf(input: EtatPaiementInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, layout: "landscape" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(input.cabinetNom, { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(13).text(`ÉTAT DE PAIEMENT — ${formatMois(input.mois).toUpperCase()}`, { align: "center" });
    doc.moveDown(1.5);

    const left = doc.page.margins.left;
    const colEmploye = left;
    const colBrut = 260;
    const colRetenues = 380;
    const colNet = 500;
    const colMode = 600;
    const colStatut = 700;
    const largeur = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("Employé", colEmploye, doc.y, { width: colBrut - colEmploye });
    doc.text("Brut", colBrut, doc.y - doc.currentLineHeight(), { width: colRetenues - colBrut, align: "right" });
    doc.text("Retenues", colRetenues, doc.y - doc.currentLineHeight(), { width: colNet - colRetenues, align: "right" });
    doc.text("Net", colNet, doc.y - doc.currentLineHeight(), { width: colMode - colNet, align: "right" });
    doc.text("Mode", colMode, doc.y - doc.currentLineHeight(), { width: colStatut - colMode });
    doc.text("Statut", colStatut, doc.y - doc.currentLineHeight(), { width: left + largeur - colStatut });
    doc.moveDown(0.4);
    doc.moveTo(left, doc.y).lineTo(left + largeur, doc.y).strokeColor("#999").stroke();
    doc.moveDown(0.4);

    doc.font("Helvetica").fontSize(9);
    for (const l of input.lignes) {
      const y = doc.y;
      doc.text(l.nomEmploye, colEmploye, y, { width: colBrut - colEmploye });
      doc.text(formatMontant(l.brut), colBrut, y, { width: colRetenues - colBrut, align: "right" });
      doc.text(formatMontant(l.totalRetenues), colRetenues, y, { width: colNet - colRetenues, align: "right" });
      doc.text(formatMontant(l.net), colNet, y, { width: colMode - colNet, align: "right" });
      doc.text(l.modePaiement ? MODE_LABELS[l.modePaiement] || l.modePaiement : "—", colMode, y, { width: colStatut - colMode });
      doc.text(STATUT_LABELS[l.statutPaiement], colStatut, y, { width: left + largeur - colStatut });
      doc.moveDown(0.5);
    }

    doc.moveDown(0.5);
    doc.moveTo(left, doc.y).lineTo(left + largeur, doc.y).strokeColor("#333").stroke();
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(11);
    doc.text(`Total brut : ${formatMontant(input.totalBrut)}    Total retenues : ${formatMontant(input.totalRetenues)}    Total net : ${formatMontant(input.totalNet)}`, left, doc.y, { width: largeur, align: "right" });

    doc.moveDown(2);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#555").text(
      "Document interne généré par Aurore. Aurore n'effectue aucun paiement réel - ce document enregistre uniquement un statut.",
      { align: "center" }
    );

    doc.end();
  });
}
