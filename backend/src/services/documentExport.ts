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
  Footer,
} from "docx";
import PDFDocument from "pdfkit";
import { formatDateLongue } from "../utils/dateFormat";
import { parseMarkdownBlocks, TextSpan } from "./markdownParse";
import { buildFormalisme } from "./documentFormalisme";

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

export type PoliceDocuments = "Times New Roman" | "Arial" | "Courier New";

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
  // Reglages du cabinet (Parametres) - defauts geres cote Prisma (Times New
  // Roman, 11) donc toujours fournis en pratique, mais optionnels ici pour
  // ne pas casser d'eventuels appelants existants.
  police?: string;
  tailleTexte?: number;
  // Formalisme juridique specifique au type de document (identite des
  // parties, huissier, greffier, juge...) - voir documentFormalisme.ts.
  // Optionnels : absents pour les types sans formalisme specifique (recherche,
  // traduction, resume...) ou pour d'eventuels appelants existants.
  typeAction?: string;
  champsDocument?: unknown;
  nomClient?: string;
  ville?: string;
  dateAudience?: Date | null;
  prochaineAudience?: Date | null;
  piecesPrevoir?: string | null;
  // Lot 11 (Partie C) : statut de l'Action au moment de l'export - determine
  // le texte exact de la mention d'avertissement ci-dessous (non fourni =
  // traite comme non valide, mention "non definitif").
  statut?: string;
}

const formatDate = formatDateLongue;

// Polices standard PDFKit (aucune police a embarquer) correspondant aux
// choix proposes dans Parametres - doit rester en phase avec cette liste,
// et avec le nom de police Word (libre, cote docx) qui porte le meme nom.
type PdfFontFamily = { regular: string; bold: string; italic: string; boldItalic: string };

const PDF_FONT_FAMILIES: Record<PoliceDocuments, PdfFontFamily> = {
  "Times New Roman": {
    regular: "Times-Roman",
    bold: "Times-Bold",
    italic: "Times-Italic",
    boldItalic: "Times-BoldItalic",
  },
  Arial: {
    regular: "Helvetica",
    bold: "Helvetica-Bold",
    italic: "Helvetica-Oblique",
    boldItalic: "Helvetica-BoldOblique",
  },
  "Courier New": {
    regular: "Courier",
    bold: "Courier-Bold",
    italic: "Courier-Oblique",
    boldItalic: "Courier-BoldOblique",
  },
};

function pdfFontFamily(police?: string): PdfFontFamily {
  return PDF_FONT_FAMILIES[(police as PoliceDocuments) ?? "Times New Roman"] ?? PDF_FONT_FAMILIES["Times New Roman"];
}

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

function spansToDocxRuns(spans: TextSpan[], extra?: { bold?: boolean; sizePt?: number }): TextRun[] {
  return spans
    .filter((s) => s.text.length > 0)
    .map(
      (s) =>
        new TextRun({
          text: s.text,
          bold: s.bold || extra?.bold,
          italics: s.italic,
          size: extra?.sizePt ? extra.sizePt * 2 : undefined,
        })
    );
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
            alignment: AlignmentType.JUSTIFIED,
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
            alignment: AlignmentType.JUSTIFIED,
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
    } else if (block.titleSizePt) {
      elements.push(
        new Paragraph({
          children: spansToDocxRuns(block.spans, { bold: true, sizePt: block.titleSizePt }),
          alignment: AlignmentType.CENTER,
          spacing: { after: 200 },
        })
      );
    } else if (block.align === "center") {
      elements.push(
        new Paragraph({
          children: spansToDocxRuns(block.spans),
          alignment: AlignmentType.CENTER,
          spacing: { after: 150 },
        })
      );
    } else if (block.align === "right") {
      elements.push(
        new Paragraph({
          children: spansToDocxRuns(block.spans),
          alignment: AlignmentType.RIGHT,
          spacing: { after: 150 },
        })
      );
    } else if (block.align === "left") {
      elements.push(
        new Paragraph({
          children: spansToDocxRuns(block.spans),
          alignment: AlignmentType.LEFT,
          spacing: { after: 150 },
        })
      );
    } else if (block.indent !== undefined) {
      elements.push(
        new Paragraph({
          children: spansToDocxRuns(block.spans),
          indent: { left: block.indent },
          spacing: { after: 100 },
        })
      );
    } else {
      // Paragraphe simple : conserve la detection historique des titres de
      // section en MAJUSCULES (actes classiques, pas de Markdown) - sauf si
      // le bloc impose explicitement un rendu normal (voir "forcePlain").
      const plainText = block.spans.map((s) => s.text).join("");
      if (!block.forcePlain && block.spans.length === 1 && !block.spans[0].bold && isHeaderLine(plainText)) {
        elements.push(
          new Paragraph({
            children: [new TextRun({ text: plainText, bold: true })],
            alignment: AlignmentType.JUSTIFIED,
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

function resolveFormalisme(input: ExportInput) {
  if (!input.typeAction) return null;
  return buildFormalisme(input.typeAction, input.champsDocument, {
    nomClient: input.nomClient || input.nomAffaire,
    nomAffaire: input.nomAffaire,
    numeroDossier: input.numeroDossier,
    dateLongue: formatDate(input.date),
    ville: input.ville || "Cotonou",
    dateAudienceLongue: input.dateAudience ? formatDate(input.dateAudience) : undefined,
    prochaineAudienceLongue: input.prochaineAudience ? formatDate(input.prochaineAudience) : undefined,
    piecesPrevoir: input.piecesPrevoir || undefined,
  });
}

// Lot 11 (Partie C) : mesure d'attenuation par la clarte, pas une garantie
// technique - Aurore ne peut pas empecher l'edition d'un .docx telecharge.
// Rappelle la date d'export et, tant que le document n'est pas valide, que
// son contenu n'est pas definitif (peut encore etre corrige/revu dans
// Aurore avant validation - voir Lot 10/11 Partie A).
function buildMentionAvertissement(input: ExportInput): string {
  const dateExport = formatDate(new Date());
  const base = `Document généré par Aurore le ${dateExport} — toute modification doit être reportée dans l'application pour rester tracée.`;
  if (input.statut === "valide" || input.statut === "envoye") {
    return base;
  }
  return `Document en cours de validation — non définitif. ${base}`;
}

export async function buildDocx(input: ExportInput): Promise<Buffer> {
  const police = input.police ?? "Times New Roman";
  const tailleTexte = input.tailleTexte ?? 11;

  // Pour les types de documents qui ont un formalisme juridique specifique
  // (identite des parties, huissier, greffier, juge...), on le reconstruit a
  // partir des champs composes (voir documentFormalisme.ts) et on l'insere
  // avant/apres le texte redige par l'IA, en remplacement du bloc courrier
  // generique ci-dessous.
  const formalisme = resolveFormalisme(input);
  const contenuComplet = formalisme
    ? [formalisme.avant, input.contenu, formalisme.apres].filter(Boolean).join("\n\n")
    : input.contenu;
  const paragraphesContenu = buildDocxContentElements(contenuComplet);

  // Bloc courrier (date/lieu + objet), toujours ajoute par la mise en page
  // elle-meme - jamais par le texte redige (voir consigne dans les prompts
  // qui interdit desormais a l'IA d'ecrire elle-meme une ligne "Fait a...").
  // Remplace par le formalisme specifique du type de document quand il existe
  // (celui-ci gere lui-meme sa propre mise en forme de date/objet).
  const enteteCourrier = formalisme
    ? []
    : [
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
  // visuellement l'image (plus large qu'avant). Idem quand un formalisme
  // specifique s'applique : il porte deja son propre titre ("REQUÊTE",
  // "ASSIGNATION"...) et l'identite des parties, ce bloc generique ferait
  // doublon.
  const titreParagraphs = input.entete || formalisme
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
            new TextRun({ text: `Rédigé par ${input.auteurNom} — ${formatDate(input.date)}`, size: (tailleTexte - 2) * 2 }),
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
          run: { font: police, size: tailleTexte * 2 },
        },
      },
    },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [new TextRun({ text: buildMentionAvertissement(input), size: 14, italics: true })],
                alignment: AlignmentType.CENTER,
              }),
            ],
          }),
        },
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
  options: { size: number; align?: "left" | "center" | "right" | "justify"; bold?: boolean },
  fontFamily: PdfFontFamily
): void {
  const nonEmpty = spans.filter((s) => s.text.length > 0);
  if (nonEmpty.length === 0) return;
  const mixedStyle =
    (nonEmpty.some((s) => s.bold) && nonEmpty.some((s) => !s.bold)) ||
    (nonEmpty.some((s) => s.italic) && nonEmpty.some((s) => !s.italic));
  const align = mixedStyle ? "left" : options.align ?? "left";

  nonEmpty.forEach((span, idx) => {
    const isLast = idx === nonEmpty.length - 1;
    const isBold = span.bold || options.bold;
    const isItalic = span.italic;
    const font = isBold && isItalic ? fontFamily.boldItalic : isBold ? fontFamily.bold : isItalic ? fontFamily.italic : fontFamily.regular;
    doc.font(font).fontSize(options.size);
    doc.text(span.text, { continued: !isLast, align });
  });
}

const PDF_TABLE_CELL_PADDING = 6;

function renderPdfTable(
  doc: PDFKit.PDFDocument,
  header: string[],
  rows: string[][],
  tailleTexte: number,
  fontFamily: PdfFontFamily
): void {
  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / header.length;
  const left = doc.page.margins.left;
  const cellSize = tailleTexte - 2;

  function rowHeight(cells: string[], bold: boolean): number {
    doc.font(bold ? fontFamily.bold : fontFamily.regular).fontSize(cellSize);
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
        .font(bold ? fontFamily.bold : fontFamily.regular)
        .fontSize(cellSize)
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
  // doc.text() avec des coordonnees explicites (voir drawRow) laisse doc.x
  // positionne sur la derniere cellule dessinee, pas sur la marge de page -
  // sans ce reset, tout le contenu qui suit le tableau se retrouve rendu
  // dans l'etroite colonne restante a droite au lieu de la pleine largeur.
  doc.x = left;
  doc.moveDown(0.8);
}

// Meme logique que buildDocxContentElements, cote PDF : transforme le texte
// redige (potentiellement du Markdown) en elements PDF reels plutot que
// d'afficher la syntaxe brute.
function renderPdfContent(
  doc: PDFKit.PDFDocument,
  contenu: string,
  tailleTexte: number,
  fontFamily: PdfFontFamily
): void {
  const blocks = parseMarkdownBlocks(contenu);
  const HEADING_SIZE = { 1: tailleTexte + 2, 2: tailleTexte + 1, 3: tailleTexte } as const;

  for (const block of blocks) {
    if (block.type === "heading") {
      doc.moveDown(0.4);
      renderPdfSpans(doc, block.spans, { size: HEADING_SIZE[block.level], bold: true, align: "left" }, fontFamily);
      doc.moveDown(0.3);
    } else if (block.type === "bullet") {
      for (const item of block.items) {
        doc.x = doc.page.margins.left + 14;
        renderPdfSpans(doc, [{ text: "• ", bold: false }, ...item], { size: tailleTexte, align: "justify" }, fontFamily);
        doc.x = doc.page.margins.left;
        doc.moveDown(0.3);
      }
    } else if (block.type === "numbered") {
      block.items.forEach((item, idx) => {
        doc.x = doc.page.margins.left + 14;
        renderPdfSpans(doc, [{ text: `${idx + 1}. `, bold: false }, ...item], { size: tailleTexte, align: "justify" }, fontFamily);
        doc.x = doc.page.margins.left;
        doc.moveDown(0.3);
      });
    } else if (block.type === "table") {
      renderPdfTable(doc, block.header, block.rows, tailleTexte, fontFamily);
    } else if (block.titleSizePt) {
      renderPdfSpans(doc, block.spans, { size: block.titleSizePt, bold: true, align: "center" }, fontFamily);
      doc.moveDown(0.5);
    } else if (block.align === "center") {
      renderPdfSpans(doc, block.spans, { size: tailleTexte, align: "center" }, fontFamily);
      doc.moveDown(0.4);
    } else if (block.align === "right") {
      renderPdfSpans(doc, block.spans, { size: tailleTexte, align: "right" }, fontFamily);
      doc.moveDown(0.4);
    } else if (block.align === "left") {
      renderPdfSpans(doc, block.spans, { size: tailleTexte, align: "left" }, fontFamily);
      doc.moveDown(0.4);
    } else if (block.indent !== undefined) {
      // Twips (unite Word, 1440 = 1 pouce) convertis en points PDF (1 pouce = 72 pt).
      doc.x = doc.page.margins.left + (block.indent / 1440) * 72;
      renderPdfSpans(doc, block.spans, { size: tailleTexte, align: "left" }, fontFamily);
      doc.x = doc.page.margins.left;
      doc.moveDown(0.3);
    } else {
      const plainText = block.spans.map((s) => s.text).join("");
      if (!block.forcePlain && block.spans.length === 1 && !block.spans[0].bold && isHeaderLine(plainText)) {
        doc.moveDown(0.4);
        renderPdfSpans(doc, block.spans, { size: tailleTexte, bold: true, align: "justify" }, fontFamily);
        doc.moveDown(0.3);
      } else {
        renderPdfSpans(doc, block.spans, { size: tailleTexte, align: "justify" }, fontFamily);
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

    const tailleTexte = input.tailleTexte ?? 11;
    const fontFamily = pdfFontFamily(input.police);

    if (input.entete) {
      const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const ENTETE_W = Math.min(450, usableWidth);
      const ENTETE_H = 121;
      const enteteX = doc.page.margins.left + (usableWidth - ENTETE_W) / 2;
      const enteteY = doc.y;
      doc.image(input.entete.buffer, enteteX, enteteY, { fit: [ENTETE_W, ENTETE_H] });
      doc.y = enteteY + ENTETE_H + 10;
    }

    // Quand il y a un en-tête, il porte deja le nom/l'identite du cabinet -
    // repeter ce bloc de titre en dessous ne fait que doublonner et, avec
    // un en-tete plus large, chevauche visuellement l'image. Idem quand un
    // formalisme specifique s'applique : il porte deja son propre titre et
    // l'identite des parties.
    const formalisme = resolveFormalisme(input);
    if (!input.entete && !formalisme) {
      doc.font(fontFamily.bold).fontSize(tailleTexte + 5).text(input.cabinetNom, { align: "center" });
      doc.moveDown(0.3);
      doc.font(fontFamily.bold).fontSize(tailleTexte).text(input.typeLabel, { align: "center" });
      doc.moveDown(0.2);
      doc
        .font(fontFamily.italic)
        .fontSize(tailleTexte - 1)
        .text(`Dossier ${input.numeroDossier} — ${input.nomAffaire}`, { align: "center" });
      doc.moveDown(0.2);
      doc
        .font(fontFamily.regular)
        .fontSize(tailleTexte - 2)
        .text(`Rédigé par ${input.auteurNom} — ${formatDate(input.date)}`, { align: "center" });
      doc.moveDown(1.2);
    } else {
      doc.moveDown(0.6);
    }

    // Bloc courrier (date/lieu + objet), toujours ajoute par la mise en
    // page elle-meme - jamais par le texte redige (voir consigne dans les
    // prompts qui interdit desormais a l'IA d'ecrire elle-meme "Fait a...").
    // Remplace par le formalisme specifique du type de document quand il
    // existe (identite des parties, huissier, greffier, juge... - voir
    // documentFormalisme.ts), celui-ci gerant lui-meme sa propre mise en
    // forme de date/objet.
    if (!formalisme) {
      doc.font(fontFamily.regular).fontSize(tailleTexte - 1).text(`Cotonou, le ${formatDate(input.date)}`, { align: "right" });
      doc.moveDown(0.6);
      doc
        .font(fontFamily.bold)
        .fontSize(tailleTexte - 1)
        .text(`Objet : ${input.typeLabel} — Dossier ${input.numeroDossier} — ${input.nomAffaire}`, {
          align: "left",
        });
      doc.moveDown(1);
    }

    const contenuComplet = formalisme
      ? [formalisme.avant, input.contenu, formalisme.apres].filter(Boolean).join("\n\n")
      : input.contenu;
    renderPdfContent(doc, contenuComplet, tailleTexte, fontFamily);

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

    // Lot 11 (Partie C) : PDFKit ne propose pas de pied de page repete par
    // page sans complexifier significativement le moteur de rendu (suivi
    // manuel des sauts de page) - mention ajoutee en toute derniere ligne du
    // document, comme prevu explicitement par la spec dans ce cas.
    doc.moveDown(1.2);
    doc
      .font(fontFamily.italic)
      .fontSize(8)
      .text(buildMentionAvertissement(input), { align: "center" });

    doc.end();
  });
}
