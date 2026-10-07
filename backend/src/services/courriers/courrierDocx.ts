import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";

/**
 * Generation Word dediee a un courrier redige "librement" (sans IA) depuis
 * l'ecran Courriers - delibere ment SEPAREE de buildDocx (services/documentExport.ts) :
 * ce dernier est concu autour d'un Dossier/Action (bloc "Objet : <type> —
 * Dossier <numero> — <affaire>", formalisme juridique specifique...), rien
 * de tout ca n'a de sens pour un simple courrier adresse a un tiers, qui a
 * besoin a la place d'un vrai bloc destinataire + objet libre. Volontairement
 * minimal pour ce lot : pas d'en-tete/signature (voir Nouvelle action pour un
 * document qui en a besoin).
 */
export interface CourrierDocxInput {
  numero: string;
  objet: string;
  destinataire: string;
  adresseDestinataire?: string;
  corps: string;
  formuleDeFin: string;
  date: Date;
}

function formatDateLettre(date: Date): string {
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

// Un paragraphe par bloc separe par une ligne vide ; a l'interieur d'un bloc,
// un saut de ligne simple reste un saut de ligne (pas un nouveau paragraphe) -
// suffisant pour un courrier, pas besoin du parseur markdown complet utilise
// pour le contenu genere par l'IA.
function paragraphesTexte(texte: string, tailleDemiPoints: number): Paragraph[] {
  return texte
    .split(/\n{2,}/)
    .map((bloc) => bloc.trim())
    .filter(Boolean)
    .map((bloc) => {
      const lignes = bloc.split("\n");
      const children: TextRun[] = [];
      lignes.forEach((ligne, idx) => {
        if (idx > 0) children.push(new TextRun({ text: "", break: 1 }));
        children.push(new TextRun({ text: ligne, size: tailleDemiPoints }));
      });
      return new Paragraph({ children, spacing: { after: 200 } });
    });
}

export async function buildCourrierDocx(input: CourrierDocxInput): Promise<Buffer> {
  const tailleDemiPoints = 13 * 2;

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [new TextRun({ text: `Réf : ${input.numero}`, size: tailleDemiPoints })],
            alignment: AlignmentType.LEFT,
            spacing: { after: 100 },
          }),
          new Paragraph({
            children: [new TextRun({ text: `Cotonou, le ${formatDateLettre(input.date)}`, size: tailleDemiPoints })],
            alignment: AlignmentType.RIGHT,
            spacing: { after: 400 },
          }),
          new Paragraph({
            children: [new TextRun({ text: input.destinataire, size: tailleDemiPoints, bold: true })],
          }),
          ...(input.adresseDestinataire
            ? [new Paragraph({ children: [new TextRun({ text: input.adresseDestinataire, size: tailleDemiPoints })] })]
            : []),
          new Paragraph({ text: "", spacing: { after: 300 } }),
          new Paragraph({
            children: [new TextRun({ text: `Objet : ${input.objet}`, size: tailleDemiPoints, bold: true })],
            spacing: { after: 400 },
          }),
          ...paragraphesTexte(input.corps, tailleDemiPoints),
          new Paragraph({ text: "", spacing: { before: 100, after: 100 } }),
          ...paragraphesTexte(input.formuleDeFin, tailleDemiPoints),
        ],
      },
    ],
    styles: {
      default: { document: { run: { font: "Times New Roman", size: tailleDemiPoints } } },
    },
  });

  return Packer.toBuffer(doc);
}
