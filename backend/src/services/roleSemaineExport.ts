import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, ShadingType } from "docx";
import { formatDateLongue } from "../utils/dateFormat";

export interface RoleSemaineAudienceInput {
  dateAudience: Date;
  juridiction: string;
  chambre: string | null;
  procedureNumero: string | null;
  parties: string;
  qualiteProcedurale: string | null;
  objetProcedure: string | null;
  dernierMotif: string | null;
  diligences: string | null;
}

export interface RoleSemaineExportInput {
  cabinetNom: string;
  audiences: RoleSemaineAudienceInput[];
}

const COLONNES = ["Heure", "Juridiction / Chambre / Procédure", "Parties", "Qualité procédurale", "Objet de la procédure", "Dernier motif / Diligences"];

function formatHeure(date: Date): string {
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function juridictionCellule(a: RoleSemaineAudienceInput): string {
  return [a.juridiction, a.chambre, a.procedureNumero].filter(Boolean).join("\n");
}

function motifCellule(a: RoleSemaineAudienceInput): string {
  return [a.dernierMotif, a.diligences].filter(Boolean).join("\n");
}

function grouperParJour(audiences: RoleSemaineAudienceInput[]): { date: Date; audiences: RoleSemaineAudienceInput[] }[] {
  const parJour = new Map<string, { date: Date; audiences: RoleSemaineAudienceInput[] }>();
  for (const a of audiences) {
    const key = a.dateAudience.toISOString().slice(0, 10);
    if (!parJour.has(key)) parJour.set(key, { date: a.dateAudience, audiences: [] });
    parJour.get(key)!.audiences.push(a);
  }
  return [...parJour.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

export async function buildRoleSemainePdf(input: RoleSemaineExportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(14).text(input.cabinetNom, { align: "center" });
    doc.font("Helvetica-Bold").fontSize(12).text("RÔLE DE LA SEMAINE", { align: "center" });
    doc.moveDown(1);

    const largeurs = [55, 175, 130, 110, 150, 175]; // somme ~795, proche de la largeur utile en landscape A4

    const jours = grouperParJour(input.audiences);

    for (const jour of jours) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 100) doc.addPage({ margin: 40, size: "A4", layout: "landscape" });

      doc.font("Helvetica-Bold").fontSize(10).fillColor("#000000");
      doc.text(`AUDIENCE DU ${formatDateLongue(jour.date).toUpperCase()}`, { align: "center" });
      doc.moveDown(0.4);

      const left = doc.page.margins.left;
      let x = left;
      const headerTop = doc.y;
      doc.font("Helvetica-Bold").fontSize(8);
      COLONNES.forEach((col, i) => {
        doc.text(col, x + 3, headerTop + 3, { width: largeurs[i] - 6 });
        x += largeurs[i];
      });
      const headerHeight = Math.max(...COLONNES.map((col, i) => doc.heightOfString(col, { width: largeurs[i] - 6 }))) + 8;
      doc.rect(left, headerTop, largeurs.reduce((a, b) => a + b, 0), headerHeight).stroke();
      x = left;
      largeurs.forEach((l) => {
        doc.moveTo(x, headerTop).lineTo(x, headerTop + headerHeight).stroke();
        x += l;
      });
      doc.moveTo(x, headerTop).lineTo(x, headerTop + headerHeight).stroke();
      doc.y = headerTop + headerHeight;

      doc.font("Helvetica").fontSize(8);
      for (const a of jour.audiences) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 60) {
          doc.addPage({ margin: 40, size: "A4", layout: "landscape" });
          doc.y = doc.page.margins.top;
        }
        const valeurs = [formatHeure(a.dateAudience), juridictionCellule(a), a.parties, a.qualiteProcedurale || "", a.objetProcedure || "", motifCellule(a)];
        const rowTop = doc.y;
        const hauteurs = valeurs.map((v, i) => doc.heightOfString(v, { width: largeurs[i] - 6 }));
        const rowHeight = Math.max(...hauteurs) + 8;
        x = left;
        valeurs.forEach((v, i) => {
          doc.text(v, x + 3, rowTop + 4, { width: largeurs[i] - 6 });
          x += largeurs[i];
        });
        doc.rect(left, rowTop, largeurs.reduce((a2, b) => a2 + b, 0), rowHeight).stroke();
        x = left;
        largeurs.forEach((l) => {
          doc.moveTo(x, rowTop).lineTo(x, rowTop + rowHeight).stroke();
          x += l;
        });
        doc.moveTo(x, rowTop).lineTo(x, rowTop + rowHeight).stroke();
        doc.y = rowTop + rowHeight;
      }
      doc.moveDown(1.2);
    }

    doc.end();
  });
}

function docxCell(text: string, options?: { bold?: boolean; shaded?: boolean }): TableCell {
  return new TableCell({
    children: text.split("\n").map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: options?.bold })] })),
    shading: options?.shaded ? { type: ShadingType.SOLID, color: "F1EEE6" } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
}

export async function buildRoleSemaineWord(input: RoleSemaineExportInput): Promise<Buffer> {
  const jours = grouperParJour(input.audiences);

  const elements: (Paragraph | Table)[] = [
    new Paragraph({ children: [new TextRun({ text: input.cabinetNom, bold: true, size: 28 })], alignment: AlignmentType.CENTER, spacing: { after: 100 } }),
    new Paragraph({ text: "RÔLE DE LA SEMAINE", heading: HeadingLevel.HEADING_1, alignment: AlignmentType.CENTER, spacing: { after: 300 } }),
  ];

  for (const jour of jours) {
    elements.push(
      new Paragraph({
        children: [new TextRun({ text: `AUDIENCE DU ${formatDateLongue(jour.date).toUpperCase()}`, bold: true })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 120 },
      })
    );
    elements.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ children: COLONNES.map((c) => docxCell(c, { bold: true, shaded: true })) }),
          ...jour.audiences.map(
            (a) =>
              new TableRow({
                children: [
                  docxCell(formatHeure(a.dateAudience)),
                  docxCell(juridictionCellule(a)),
                  docxCell(a.parties),
                  docxCell(a.qualiteProcedurale || ""),
                  docxCell(a.objetProcedure || ""),
                  docxCell(motifCellule(a)),
                ],
              })
          ),
        ],
      })
    );
    elements.push(new Paragraph({ text: "", spacing: { after: 200 } }));
  }

  const document = new Document({
    sections: [
      {
        properties: { page: { size: { orientation: "landscape" } } },
        children: elements,
      },
    ],
  });

  return Packer.toBuffer(document);
}
