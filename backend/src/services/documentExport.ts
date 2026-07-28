import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
} from "docx";
import PDFDocument from "pdfkit";
import { formatDateLongue } from "../utils/dateFormat";
import { parseMarkdownBlocks, TextSpan } from "./markdownParse";

export type SignatureAlignment = "START" | "CENTER" | "END";

export interface SignatureInput {
  buffer: Buffer;
  alignment: SignatureAlignment;
  type: "png" | "jpg";
}

export interface EnteteInput {
  buffer: Buffer;
  type: "png" | "jpg";
}

export interface ExportInput {
  cabinetNom: string;
  numeroDossier: string;
  nomAffaire: string;
  typeLabel: string;
  contenu: string;
  auteurNom: string;
  date: Date;
  signature?: SignatureInput;
  entete?: EnteteInput;
}

const formatDate = formatDateLongue;

// Certains prompts de redaction (assignation, plainte...) structurent le
// texte avec des titres de section en MAJUSCULES sur leur propre ligne
// (ex: "PAR CES MOTIFS"), sans balise markdown - on les detecte ici pour
// les mettre en valeur (gras) dans les exports Word/PDF plutot que de les
// afficher comme un paragraphe normal.
function isHeaderLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return false;
  if (!/[A-ZÀ-Ý]/.test(trimmed)) return false;
  return trimmed === trimmed.toUpperCase();
}

const DOCX_ALIGNMENT: Record<SignatureAlignment, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  START: AlignmentType.LEFT,
  CENTER: AlignmentType.CENTER,
  END: AlignmentType.RIGHT,
};

const DOCX_HEADING_LEVEL = {
  1: HeadingLevel.HEADING_2,
  2: HeadingLevel.HEADING_3,
  3: HeadingLevel.HEADING_4,
} as const;

function spansToDocxRuns(spans: TextSpan[], extra?: { bold?: boolean }): TextRun[] {
  return spans
    .filter((s) => s.text.length > 0)
    .map((s) => new TextRun({ text: s.text, bold: s.bold || extra?.bold }));
}

function docxTableCell(text: string, options?: { bold?: boolean; shaded?: boolean }): TableCell {
  return new TableCell({
    children: [
      new Paragraph({ children: [new TextRun({ text, bold: options?.bold })] }),
    ],
    shading: options?.shaded ? { type: ShadingType.SOLID, color: "F1EEE6" } : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}

// Convertit le texte redige (potentiellement du Markdown - titres, gras,
// listes, tableaux - pour Recherche juridique/Jurisprudence/Resume PDF, ou
// du texte simple avec d'anciens titres en MAJUSCULES pour les autres
// actes) en elements docx reels, plutot que d'afficher la syntaxe brute.
function buildDocxContentElements(contenu: string): (Paragraph | Table)[] {
  const blocks = parseMarkdownBlocks(contenu);
  const elements: (Paragraph | Table)[] = [];

  for (const block of blocks) {
    if (block.type === "heading") {
      elements.push(
        new Paragraph({
          children: spansToDocxRuns(block.spans),
          heading: DOCX_HEADING_LEVEL[block.level],
          spacing: { before: 200, after: 120 },
        })
      );
    } else if (block.type === "bullet") {
      for (const item of block.items) {
        elements.push(
          new Paragraph({
            children: [new TextRun("• "), ...spansToDocxRuns(item)],
            indent: { left: 360 },
            spacing: { after: 80 },
          })
        );
      }
    } else if (block.type === "numbered") {
      block.items.forEach((item, idx) => {
        elements.push(
          new Paragraph({
            children: [new TextRun(`${idx + 1}. `), ...spansToDocxRuns(item)],
            indent: { left: 360 },
            spacing: { after: 80 },
          })
        );
      });
    } else if (block.type === "table") {
      elements.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: block.header.map((cell) => docxTableCell(cell, { bold: true, shaded: true })),
            }),
            ...block.rows.map(
              (row) => new TableRow({ children: row.map((cell) => docxTableCell(cell)) })
            ),
          ],
        })
      );
      // Espace apres le tableau (docx n'accepte pas deux Table consecutives
      // sans paragraphe entre les deux si un autre bloc suit immediatement).
      elements.push(new Paragraph({ text: "", spacing: { after: 100 } }));
    } else {
      // Paragraphe simple : conserve la detection historique des titres de
      // section en MAJUSCULES (actes classiques, pas de Markdown).
      const plainText = block.spans.map((s) => s.text).join("");
      if (block.spans.length === 1 && !block.spans[0].bold && isHeaderLine(plainText)) {
        elements.push(
          new Paragraph({
            children: [new TextRun({ text: plainText, bold: true })],
            spacing: { before: 200, after: 150 },
          })
        );
      } else {
        elements.push(
          new Paragraph({
            children: spansToDocxRuns(block.spans),
            alignment: AlignmentType.JUSTIFIED,
            spacing: { after: 200 },
          })
        );
      }
    }
  }

  return elements;
}

export async function buildDocx(input: ExportInput): Promise<Buffer> {
  const paragraphesContenu = buildDocxContentElements(input.contenu);

  // Bloc courrier (date/lieu + objet), toujours ajoute par la mise en page
  // elle-meme - jamais par le texte redige (voir consigne dans les prompts
  // qui interdit desormais a l'IA d'ecrire elle-meme une ligne "Fait a...").
  const enteteCourrier = [
    new Paragraph({
      children: [new TextRun({ text: `Cotonou, le ${formatDate(input.date)}` })],
      alignment: AlignmentType.RIGHT,
      spacing: { after: 200 },
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Objet : ${input.typeLabel} — Dossier ${input.numeroDossier} — ${input.nomAffaire}`,
          bold: true,
        }),
      ],
      alignment: AlignmentType.LEFT,
      spacing: { after: 300 },
    }),
  ];

  const enteteParagraph = input.entete
    ? [
        new Paragraph({
          children: [
            new ImageRun({
              data: input.entete.buffer,
              transformation: { width: 450, height: 121 },
              type: input.entete.type,
            }),
          ],
          alignment: AlignmentType.CENTER,
          spacing: { after: 300 },
        }),
      ]
    : [];

  // Quand il y a un en-tête, il porte deja le nom/l'identite du cabinet -
  // repeter ce bloc de titre en dessous ne fait que doublonner et chevauche
  // visuellement l'image (plus large qu'avant).
  const titreParagraphs = input.entete
    ? []
    : [
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
      ];

  const signatureParagraph = input.signature
    ? [
        new Paragraph({
          children: [
            new ImageRun({
              data: input.signature.buffer,
              transformation: { width: 150, height: 60 },
              type: input.signature.type,
            }),
          ],
          alignment: DOCX_ALIGNMENT[input.signature.alignment],
          spacing: { before: 200 },
        }),
      ]
    : [];

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Arial" },
        },
      },
    },
    sections: [
      {
        children: [
          ...enteteParagraph,
          ...titreParagraphs,
          ...enteteCourrier,
          ...paragraphesContenu,
          ...signatureParagraph,
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

// Rend une ligne de texte pouvant melanger des passages normaux et gras
// (ex: "Un texte avec **un mot en gras**") sur le document PDF en cours.
// La justification n'est fiable que sur une ligne a un seul style : au-dela,
// on repasse en alignement a gauche plutot que de risquer un rendu casse.
function renderPdfSpans(
  doc: PDFKit.PDFDocument,
  spans: TextSpan[],
  options: { size: number; align?: "left" | "justify"; bold?: boolean }
): void {
  const nonEmpty = spans.filter((s) => s.text.length > 0);
  if (nonEmpty.length === 0) return;
  const mixedStyle = nonEmpty.some((s) => s.bold) && nonEmpty.some((s) => !s.bold);
  const align = mixedStyle ? "left" : options.align ?? "left";

  nonEmpty.forEach((span, idx) => {
    const isLast = idx === nonEmpty.length - 1;
    doc.font(span.bold || options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(options.size);
    doc.text(span.text, { continued: !isLast, align });
  });
}

const PDF_TABLE_CELL_PADDING = 6;

function renderPdfTable(doc: PDFKit.PDFDocument, header: string[], rows: string[][]): void {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / header.length;
  const left = doc.page.margins.left;

  function rowHeight(cells: string[], bold: boolean): number {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    return Math.max(
      ...cells.map(
        (c) => doc.heightOfString(c, { width: colWidth - PDF_TABLE_CELL_PADDING * 2 }) + PDF_TABLE_CELL_PADDING * 2
      )
    );
  }

  function ensureSpace(height: number): void {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
    }
  }

  function drawRow(cells: string[], bold: boolean, shaded: boolean): void {
    const height = rowHeight(cells, bold);
    ensureSpace(height);
    const top = doc.y;
    if (shaded) {
      doc.rect(left, top, usableWidth, height).fill("#f1eee6");
    }
    doc.strokeColor("#bbb");
    cells.forEach((cell, i) => {
      const x = left + i * colWidth;
      doc.rect(x, top, colWidth, height).stroke();
      doc
        .fillColor("#000")
        .font(bold ? "Helvetica-Bold" : "Helvetica")
        .fontSize(9)
        .text(cell, x + PDF_TABLE_CELL_PADDING, top + PDF_TABLE_CELL_PADDING, {
          width: colWidth - PDF_TABLE_CELL_PADDING * 2,
        });
    });
    doc.y = top + height;
  }

  drawRow(header, true, true);
  for (const row of rows) {
    drawRow(row, false, false);
  }
  doc.moveDown(0.8);
}

// Meme logique que buildDocxContentElements, cote PDF : transforme le texte
// redige (potentiellement du Markdown) en elements PDF reels plutot que
// d'afficher la syntaxe brute.
function renderPdfContent(doc: PDFKit.PDFDocument, contenu: string): void {
  const blocks = parseMarkdownBlocks(contenu);
  const HEADING_SIZE = { 1: 13, 2: 12, 3: 11 } as const;

  for (const block of blocks) {
    if (block.type === "heading") {
      doc.moveDown(0.4);
      renderPdfSpans(doc, block.spans, { size: HEADING_SIZE[block.level], bold: true, align: "left" });
      doc.moveDown(0.3);
    } else if (block.type === "bullet") {
      for (const item of block.items) {
        doc.x = doc.page.margins.left + 14;
        renderPdfSpans(doc, [{ text: "• ", bold: false }, ...item], { size: 11, align: "left" });
        doc.x = doc.page.margins.left;
        doc.moveDown(0.3);
      }
    } else if (block.type === "numbered") {
      block.items.forEach((item, idx) => {
        doc.x = doc.page.margins.left + 14;
        renderPdfSpans(doc, [{ text: `${idx + 1}. `, bold: false }, ...item], { size: 11, align: "left" });
        doc.x = doc.page.margins.left;
        doc.moveDown(0.3);
      });
    } else if (block.type === "table") {
      renderPdfTable(doc, block.header, block.rows);
    } else {
      const plainText = block.spans.map((s) => s.text).join("");
      if (block.spans.length === 1 && !block.spans[0].bold && isHeaderLine(plainText)) {
        doc.moveDown(0.4);
        renderPdfSpans(doc, block.spans, { size: 11, bold: true, align: "left" });
        doc.moveDown(0.3);
      } else {
        renderPdfSpans(doc, block.spans, { size: 11, align: "justify" });
        doc.moveDown(0.6);
      }
    }
  }
}

const PDF_SIGNATURE_WIDTH = 150;

export async function buildPdf(input: ExportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (input.entete) {
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const enteteWidth = 450;
      doc.image(input.entete.buffer, doc.page.margins.left + (usableWidth - enteteWidth) / 2, doc.y, {
        width: enteteWidth,
      });
      doc.moveDown(3.5);
    }

    // Quand il y a un en-tête, il porte deja le nom/l'identite du cabinet -
    // repeter ce bloc de titre en dessous ne fait que doublonner et, avec
    // un en-tete plus large, chevauche visuellement l'image.
    if (!input.entete) {
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
    } else {
      doc.moveDown(0.6);
    }

    // Bloc courrier (date/lieu + objet), toujours ajoute par la mise en
    // page elle-meme - jamais par le texte redige (voir consigne dans les
    // prompts qui interdit desormais a l'IA d'ecrire elle-meme "Fait a...").
    doc.font("Helvetica").fontSize(10).text(`Cotonou, le ${formatDate(input.date)}`, { align: "right" });
    doc.moveDown(0.6);
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(`Objet : ${input.typeLabel} — Dossier ${input.numeroDossier} — ${input.nomAffaire}`, {
        align: "left",
      });
    doc.moveDown(1);

    renderPdfContent(doc, input.contenu);

    if (input.signature) {
      doc.moveDown(1);
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      let x = doc.page.margins.left;
      if (input.signature.alignment === "CENTER") {
        x = doc.page.margins.left + (usableWidth - PDF_SIGNATURE_WIDTH) / 2;
      } else if (input.signature.alignment === "END") {
        x = doc.page.margins.left + usableWidth - PDF_SIGNATURE_WIDTH;
      }
      doc.image(input.signature.buffer, x, doc.y, { width: PDF_SIGNATURE_WIDTH });
    }

    doc.end();
  });
}
