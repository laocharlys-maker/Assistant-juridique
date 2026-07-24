import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } from "docx";
import PDFDocument from "pdfkit";

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

function formatDate(date: Date): string {
  return date.toLocaleDateString("fr-FR", { year: "numeric", month: "long", day: "numeric" });
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

export async function buildDocx(input: ExportInput): Promise<Buffer> {
  const paragraphesContenu = input.contenu
    .split(/\n+/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const trimmed = line.trim();
      if (isHeaderLine(trimmed)) {
        return new Paragraph({
          children: [new TextRun({ text: trimmed, bold: true })],
          spacing: { before: 200, after: 150 },
        });
      }
      return new Paragraph({
        children: [new TextRun(trimmed)],
        spacing: { after: 200 },
      });
    });

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
          ...paragraphesContenu,
          ...signatureParagraph,
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
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

    const paragraphes = input.contenu.split(/\n+/).filter((line) => line.trim().length > 0);
    for (const paragraphe of paragraphes) {
      const trimmed = paragraphe.trim();
      if (isHeaderLine(trimmed)) {
        doc.moveDown(0.4);
        doc.font("Helvetica-Bold").fontSize(11).text(trimmed, { align: "left" });
        doc.moveDown(0.3);
      } else {
        doc.font("Helvetica").fontSize(11).text(trimmed, { align: "justify" });
        doc.moveDown(0.6);
      }
    }

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
