import PDFDocument from "pdfkit";
import { formatDateLongue } from "../utils/dateFormat";

/**
 * Lot 14 - agregation des feuilles de temps + export PDF. Responsabilite
 * volontairement separee du chronometrage (routes/saisiesTemps.ts, qui
 * demarre/arrete/arrondit une duree) - ce module ne fait QUE sommer des
 * SaisieTemps deja enregistrees (dureeMinutes deja arrondie a la creation),
 * jamais de nouveau calcul de duree.
 */

export interface SaisiePourAgregation {
  userId: string;
  userNom: string;
  dossierId: string;
  dossierLabel: string;
  dureeMinutes: number;
  tauxHoraireApplique: number | null;
}

export interface LigneAgregee {
  cle: string;
  label: string;
  dureeMinutes: number;
  montant: number;
}

/** Montant en FCFA pour une duree/taux donnes - null si le taux n'etait pas
 * configure au moment de la saisie (voir SaisieTemps.tauxHoraireApplique).
 * Chaque saisie garde son PROPRE taux snapshotte : on ne peut donc jamais
 * multiplier une duree totale par un taux unique, seulement sommer des
 * montants deja calcules saisie par saisie. */
export function calculerMontant(dureeMinutes: number, tauxHoraireApplique: number | null): number {
  if (tauxHoraireApplique === null) return 0;
  return Math.round((dureeMinutes / 60) * tauxHoraireApplique);
}

/** "3h30", "45min", "2h" - format compact coherent utilise partout dans les
 * fiches (affichage et PDF), a partir d'une duree deja arrondie a la
 * minute (voir routes/saisiesTemps.ts, arrondirMinutes). */
export function formatDuree(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

function agreger(saisies: SaisiePourAgregation[], cleDe: (s: SaisiePourAgregation) => string, labelDe: (s: SaisiePourAgregation) => string): LigneAgregee[] {
  const parCle = new Map<string, LigneAgregee>();
  for (const s of saisies) {
    const cle = cleDe(s);
    if (!parCle.has(cle)) {
      parCle.set(cle, { cle, label: labelDe(s), dureeMinutes: 0, montant: 0 });
    }
    const ligne = parCle.get(cle)!;
    ligne.dureeMinutes += s.dureeMinutes;
    ligne.montant += calculerMontant(s.dureeMinutes, s.tauxHoraireApplique);
  }
  return [...parCle.values()].sort((a, b) => a.label.localeCompare(b.label, "fr"));
}

/** Agregation par collaborateur - charge de travail par personne sur la
 * periode/le perimetre demande. */
export function agregerParCollaborateur(saisies: SaisiePourAgregation[]): LigneAgregee[] {
  return agreger(saisies, (s) => s.userId, (s) => s.userNom);
}

/** Agregation par dossier - base directe de "Facturer ce dossier" (voir
 * routes/factures.ts) et utile pour visualiser le temps total investi sur
 * une affaire, tous collaborateurs confondus. */
export function agregerParDossier(saisies: SaisiePourAgregation[]): LigneAgregee[] {
  return agreger(saisies, (s) => s.dossierId, (s) => s.dossierLabel);
}

export interface FeuilleTempsExportInput {
  cabinetNom: string;
  titre: string;
  sousTitre?: string;
  lignes: LigneAgregee[];
}

function formatMontant(montant: number): string {
  return `${montant.toLocaleString("fr-FR")} F CFA`;
}

/** Export PDF d'une feuille de temps deja agregee (par collaborateur OU par
 * dossier, selon ce que l'appelant a passe dans `lignes`) - reutilise
 * pdfkit, meme style sobre que services/facturePdf.ts (pas de tableau a
 * bordures manuelles comme roleSemaineExport.ts : une feuille de temps a
 * peu de colonnes, un alignement par tabulation suffit et reste lisible). */
export async function buildFeuilleTempsPdf(input: FeuilleTempsExportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(input.cabinetNom, { align: "center" });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(13).text(input.titre, { align: "center" });
    if (input.sousTitre) {
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(10).text(input.sousTitre, { align: "center" });
    }
    doc.moveDown(1.2);

    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const colLabel = usableWidth * 0.5;
    const colTemps = usableWidth * 0.25;
    const colMontant = usableWidth * 0.25;

    const enTete = (y: number) => {
      doc.font("Helvetica-Bold").fontSize(9);
      const x = left;
      doc.text("", x, y);
      doc.text("Temps", x + colLabel, y, { width: colTemps, align: "right" });
      doc.text("Montant", x + colLabel + colTemps, y, { width: colMontant, align: "right" });
    };

    const ligneTop = doc.y;
    enTete(ligneTop);
    doc.moveDown(0.4);
    doc.moveTo(left, doc.y).lineTo(left + usableWidth, doc.y).stroke();
    doc.moveDown(0.4);

    let totalDuree = 0;
    let totalMontant = 0;

    doc.font("Helvetica").fontSize(10);
    for (const ligne of input.lignes) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) {
        doc.addPage();
        doc.y = doc.page.margins.top;
      }
      const y = doc.y;
      doc.text(ligne.label, left, y, { width: colLabel });
      doc.text(formatDuree(ligne.dureeMinutes), left + colLabel, y, { width: colTemps, align: "right" });
      doc.text(formatMontant(ligne.montant), left + colLabel + colTemps, y, {
        width: colMontant,
        align: "right",
      });
      doc.moveDown(0.6);

      totalDuree += ligne.dureeMinutes;
      totalMontant += ligne.montant;
    }

    doc.moveTo(left, doc.y).lineTo(left + usableWidth, doc.y).stroke();
    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").fontSize(10);
    const yTotal = doc.y;
    doc.text("Total", left, yTotal, { width: colLabel });
    doc.text(formatDuree(totalDuree), left + colLabel, yTotal, { width: colTemps, align: "right" });
    doc.text(formatMontant(totalMontant), left + colLabel + colTemps, yTotal, {
      width: colMontant,
      align: "right",
    });

    doc.moveDown(2);
    doc
      .font("Helvetica-Oblique")
      .fontSize(8)
      .fillColor("#6b6a64")
      .text(`Généré le ${formatDateLongue(new Date())}.`, { align: "center" });

    doc.end();
  });
}
