import PDFDocument from "pdfkit";

/**
 * Module RH Cabinet, RH-5 (voir docs/rh/) - PDF de fiche de paie. Mention
 * obligatoire sur CHAQUE PDF (spec section 2, non negociable) : ce n'est
 * jamais presente comme un bulletin de paie legal.
 */
export interface FichePaieLigneInput {
  sens: "gain" | "retenue";
  libelle: string;
  base: number | null;
  taux: number | null;
  montant: number;
}

export interface FichePaiePdfInput {
  cabinetNom: string;
  numero: string;
  mois: string; // "AAAA-MM"
  nomEmploye: string;
  fonction: string | null;
  lignes: FichePaieLigneInput[];
  brut: number;
  totalRetenues: number;
  net: number;
}

function formatMontant(montant: number): string {
  const separe = Math.round(montant)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${separe} F CFA`;
}

const MOIS_LABELS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

function formatMois(mois: string): string {
  const [annee, moisNum] = mois.split("-").map(Number);
  return `${MOIS_LABELS[moisNum - 1]} ${annee}`;
}

export async function buildFichePaiePdf(input: FichePaiePdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(input.cabinetNom, { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(13).text("FICHE DE PAIE (DOCUMENT INTERNE)", { align: "center" });
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(10);
    doc.text(`N° ${input.numero}`);
    doc.text(`Période : ${formatMois(input.mois)}`);
    doc.text(`Employé(e) : ${input.nomEmploye}${input.fonction ? " — " + input.fonction : ""}`);
    doc.moveDown(1);

    const colLibelle = doc.page.margins.left;
    const colBase = 280;
    const colTaux = 360;
    const colMontant = 420;
    const largeurTable = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    function ligneEntete() {
      doc.font("Helvetica-Bold").fontSize(9);
      doc.text("Libellé", colLibelle, doc.y, { continued: false, width: colBase - colLibelle });
      doc.text("Base", colBase, doc.y - doc.currentLineHeight(), { width: colTaux - colBase });
      doc.text("Taux", colTaux, doc.y - doc.currentLineHeight(), { width: colMontant - colTaux });
      doc.text("Montant", colMontant, doc.y - doc.currentLineHeight(), { width: doc.page.margins.left + largeurTable - colMontant, align: "right" });
      doc.moveDown(0.3);
      doc.moveTo(colLibelle, doc.y).lineTo(colLibelle + largeurTable, doc.y).strokeColor("#999").stroke();
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9);
    }

    function ligneMontant(libelle: string, base: number | null, taux: number | null, montant: number, gras = false) {
      const y = doc.y;
      doc.font(gras ? "Helvetica-Bold" : "Helvetica");
      doc.text(libelle, colLibelle, y, { width: colBase - colLibelle });
      doc.text(base !== null ? formatMontant(base) : "—", colBase, y, { width: colTaux - colBase });
      doc.text(taux !== null ? `${taux}%` : "—", colTaux, y, { width: colMontant - colTaux });
      doc.text(formatMontant(montant), colMontant, y, { width: doc.page.margins.left + largeurTable - colMontant, align: "right" });
      doc.moveDown(0.5);
    }

    doc.font("Helvetica-Bold").fontSize(10).text("Gains", colLibelle);
    doc.moveDown(0.3);
    ligneEntete();
    for (const l of input.lignes.filter((l) => l.sens === "gain")) {
      ligneMontant(l.libelle, l.base, l.taux, l.montant);
    }
    doc.moveDown(0.5);

    doc.font("Helvetica-Bold").fontSize(10).text("Retenues", colLibelle);
    doc.moveDown(0.3);
    ligneEntete();
    for (const l of input.lignes.filter((l) => l.sens === "retenue")) {
      ligneMontant(l.libelle, l.base, l.taux, l.montant);
    }
    doc.moveDown(1);

    doc.moveTo(colLibelle, doc.y).lineTo(colLibelle + largeurTable, doc.y).strokeColor("#333").stroke();
    doc.moveDown(0.5);
    ligneMontant("Total brut", null, null, input.brut, true);
    ligneMontant("Total retenues", null, null, input.totalRetenues, true);
    doc.font("Helvetica-Bold").fontSize(12);
    ligneMontant("NET À PAYER", null, null, input.net, true);

    doc.moveDown(2);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#555").text(
      "Document interne généré par Aurore, à faire valider par votre comptable. " +
        "Le format n'est pas garanti conforme comme bulletin de paie légal au Bénin : " +
        "à faire valider par un expert-comptable local avant toute utilisation officielle.",
      { align: "center" }
    );

    doc.end();
  });
}
