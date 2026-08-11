import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, ShadingType } from "docx";
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

// Autres evenements (rdv/appel/tache/echeance_procedure/autre) - champs
// generiques d'Evenement, sans commune mesure avec les champs riches d'une
// audience (juridiction, parties...) : section separee du document, jamais
// force dans le meme tableau (voir buildRoleSemainePdf/Word).
export interface RoleSemaineEvenementInput {
  // Libelle deja resolu (ex: "RDV", "Tâche") - ce module reste agnostique
  // de l'enum TypeEvenement, resolu en amont par routes/roleAudiences.ts.
  type: string;
  titre: string;
  dateDebut: Date;
  dateFin: Date | null;
  touteLaJournee: boolean;
  lieu: string | null;
  description: string | null;
}

export interface RoleSemaineExportInput {
  cabinetNom: string;
  cabinetAdresse: string | null;
  // Periode [debut, fin[ (fin exclue - le lundi suivant la semaine
  // couverte), utilisee uniquement pour l'intitule "Role de la semaine du
  // ... au ...".
  debut: Date;
  fin: Date;
  audiences: RoleSemaineAudienceInput[];
  autresEvenements: RoleSemaineEvenementInput[];
}

const COLONNES = ["Heure", "Juridiction / Chambre / Procédure", "Parties", "Qualité procédurale", "Objet de la procédure", "Dernier motif / Diligences"];
const COLONNES_AUTRES_EVENEMENTS = ["Heure", "Type", "Titre", "Lieu", "Description"];

function formatHeure(date: Date): string {
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

// Date courte (sans jour de la semaine) pour l'intitule de periode, ex:
// "10 août 2026" - a ne pas confondre avec formatDateLongue (avec jour),
// utilisee pour les en-tetes "AUDIENCE DU ...".
function formatDateCourte(date: Date): string {
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

function formatIntituleSemaine(debut: Date, fin: Date): string {
  const dernierJour = new Date(fin);
  dernierJour.setUTCDate(dernierJour.getUTCDate() - 1);
  return `Rôle de la semaine du ${formatDateCourte(debut)} au ${formatDateCourte(dernierJour)}`;
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

function formatHeureEvenement(e: RoleSemaineEvenementInput): string {
  return e.touteLaJournee ? "Toute la journée" : formatHeure(e.dateDebut);
}

function grouperEvenementsParJour(
  evenements: RoleSemaineEvenementInput[]
): { date: Date; evenements: RoleSemaineEvenementInput[] }[] {
  const parJour = new Map<string, { date: Date; evenements: RoleSemaineEvenementInput[] }>();
  for (const e of evenements) {
    const key = e.dateDebut.toISOString().slice(0, 10);
    if (!parJour.has(key)) parJour.set(key, { date: e.dateDebut, evenements: [] });
    parJour.get(key)!.evenements.push(e);
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

    const left = doc.page.margins.left;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // Centrage : toujours fixer x = left et width = usableWidth avant un
    // text({align:"center"}) - sans ca, pdfkit centre par rapport a la
    // position courante de doc.x (heritee du dernier appel), ce qui decale
    // et fait parfois retourner le texte a la ligne a tort.
    const centrer = (texte: string, y?: number) => doc.text(texte, left, y ?? doc.y, { width: usableWidth, align: "center" });

    doc.font("Helvetica-Bold").fontSize(16);
    centrer(input.cabinetNom);
    if (input.cabinetAdresse) {
      doc.font("Helvetica").fontSize(10);
      centrer(input.cabinetAdresse);
    }
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(13);
    centrer(formatIntituleSemaine(input.debut, input.fin));
    doc.moveDown(1);

    // Largeurs de colonnes calculees a partir de la largeur utile reelle de
    // la page (leur somme doit correspondre exactement, sinon la derniere
    // colonne deborde de la marge droite) - jamais de valeurs codees en dur.
    const poidsColonnes = [60, 175, 130, 110, 150, 170];
    const poidsTotal = poidsColonnes.reduce((a, b) => a + b, 0);
    const largeurs = poidsColonnes.map((p) => (p / poidsTotal) * usableWidth);
    largeurs[largeurs.length - 1] += usableWidth - largeurs.reduce((a, b) => a + b, 0);

    const jours = grouperParJour(input.audiences);

    const nouvellePage = () => {
      doc.addPage({ margin: 40, size: "A4", layout: "landscape" });
      doc.y = doc.page.margins.top;
    };

    for (const jour of jours) {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 110) nouvellePage();

      doc.font("Helvetica-Bold").fontSize(11).fillColor("#000000");
      centrer(`AUDIENCE DU ${formatDateLongue(jour.date).toUpperCase()}`);
      doc.moveDown(0.5);

      let x = left;
      const headerTop = doc.y;
      doc.font("Helvetica-Bold").fontSize(9);
      COLONNES.forEach((col, i) => {
        doc.text(col, x + 4, headerTop + 4, { width: largeurs[i] - 8 });
        x += largeurs[i];
      });
      const headerHeight = Math.max(...COLONNES.map((col, i) => doc.heightOfString(col, { width: largeurs[i] - 8 }))) + 10;
      doc.rect(left, headerTop, usableWidth, headerHeight).stroke();
      x = left;
      largeurs.forEach((l) => {
        doc.moveTo(x, headerTop).lineTo(x, headerTop + headerHeight).stroke();
        x += l;
      });
      doc.moveTo(x, headerTop).lineTo(x, headerTop + headerHeight).stroke();
      doc.y = headerTop + headerHeight;

      doc.font("Helvetica").fontSize(9);
      for (const a of jour.audiences) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 60) nouvellePage();

        const valeurs = [formatHeure(a.dateAudience), juridictionCellule(a), a.parties, a.qualiteProcedurale || "", a.objetProcedure || "", motifCellule(a)];
        const rowTop = doc.y;
        const hauteurs = valeurs.map((v, i) => doc.heightOfString(v, { width: largeurs[i] - 8 }));
        const rowHeight = Math.max(...hauteurs) + 10;
        x = left;
        valeurs.forEach((v, i) => {
          doc.text(v, x + 4, rowTop + 5, { width: largeurs[i] - 8 });
          x += largeurs[i];
        });
        doc.rect(left, rowTop, usableWidth, rowHeight).stroke();
        x = left;
        largeurs.forEach((l) => {
          doc.moveTo(x, rowTop).lineTo(x, rowTop + rowHeight).stroke();
          x += l;
        });
        doc.moveTo(x, rowTop).lineTo(x, rowTop + rowHeight).stroke();
        doc.y = rowTop + rowHeight;
      }
      doc.moveDown(1.3);
    }

    // Section separee (jamais mêlee au tableau des audiences ci-dessus, dont
    // les colonnes riches - juridiction, parties... - n'ont pas d'equivalent
    // pour un rdv/appel/tache) - memes principes de dessin, 5 colonnes.
    if (input.autresEvenements.length > 0) {
      const poidsColonnesAutres = [60, 90, 180, 130, 230];
      const poidsTotalAutres = poidsColonnesAutres.reduce((a, b) => a + b, 0);
      const largeursAutres = poidsColonnesAutres.map((p) => (p / poidsTotalAutres) * usableWidth);
      largeursAutres[largeursAutres.length - 1] += usableWidth - largeursAutres.reduce((a, b) => a + b, 0);

      if (doc.y > doc.page.height - doc.page.margins.bottom - 110) nouvellePage();
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#000000");
      centrer("AUTRES ÉVÉNEMENTS DE LA SEMAINE");
      doc.moveDown(1);

      const joursAutres = grouperEvenementsParJour(input.autresEvenements);

      for (const jour of joursAutres) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 110) nouvellePage();

        doc.font("Helvetica-Bold").fontSize(11).fillColor("#000000");
        centrer(formatDateLongue(jour.date).toUpperCase());
        doc.moveDown(0.5);

        let x = left;
        const headerTop = doc.y;
        doc.font("Helvetica-Bold").fontSize(9);
        COLONNES_AUTRES_EVENEMENTS.forEach((col, i) => {
          doc.text(col, x + 4, headerTop + 4, { width: largeursAutres[i] - 8 });
          x += largeursAutres[i];
        });
        const headerHeight =
          Math.max(...COLONNES_AUTRES_EVENEMENTS.map((col, i) => doc.heightOfString(col, { width: largeursAutres[i] - 8 }))) + 10;
        doc.rect(left, headerTop, usableWidth, headerHeight).stroke();
        x = left;
        largeursAutres.forEach((l) => {
          doc.moveTo(x, headerTop).lineTo(x, headerTop + headerHeight).stroke();
          x += l;
        });
        doc.moveTo(x, headerTop).lineTo(x, headerTop + headerHeight).stroke();
        doc.y = headerTop + headerHeight;

        doc.font("Helvetica").fontSize(9);
        for (const e of jour.evenements) {
          if (doc.y > doc.page.height - doc.page.margins.bottom - 60) nouvellePage();

          const valeurs = [formatHeureEvenement(e), e.type, e.titre, e.lieu || "", e.description || ""];
          const rowTop = doc.y;
          const hauteurs = valeurs.map((v, i) => doc.heightOfString(v, { width: largeursAutres[i] - 8 }));
          const rowHeight = Math.max(...hauteurs) + 10;
          x = left;
          valeurs.forEach((v, i) => {
            doc.text(v, x + 4, rowTop + 5, { width: largeursAutres[i] - 8 });
            x += largeursAutres[i];
          });
          doc.rect(left, rowTop, usableWidth, rowHeight).stroke();
          x = left;
          largeursAutres.forEach((l) => {
            doc.moveTo(x, rowTop).lineTo(x, rowTop + rowHeight).stroke();
            x += l;
          });
          doc.moveTo(x, rowTop).lineTo(x, rowTop + rowHeight).stroke();
          doc.y = rowTop + rowHeight;
        }
        doc.moveDown(1.3);
      }
    }

    doc.end();
  });
}

function docxCell(text: string, options?: { bold?: boolean; shaded?: boolean }): TableCell {
  return new TableCell({
    children: text.split("\n").map((line) => new Paragraph({ children: [new TextRun({ text: line, bold: options?.bold, size: 21 })] })),
    shading: options?.shaded ? { type: ShadingType.SOLID, color: "F1EEE6" } : undefined,
    margins: { top: 60, bottom: 60, left: 80, right: 80 },
  });
}

export async function buildRoleSemaineWord(input: RoleSemaineExportInput): Promise<Buffer> {
  const jours = grouperParJour(input.audiences);

  const elements: (Paragraph | Table)[] = [
    new Paragraph({ children: [new TextRun({ text: input.cabinetNom, bold: true, size: 32 })], alignment: AlignmentType.CENTER, spacing: { after: 80 } }),
  ];
  if (input.cabinetAdresse) {
    elements.push(
      new Paragraph({ children: [new TextRun({ text: input.cabinetAdresse, size: 20 })], alignment: AlignmentType.CENTER, spacing: { after: 120 } })
    );
  }
  elements.push(
    new Paragraph({
      children: [new TextRun({ text: formatIntituleSemaine(input.debut, input.fin), bold: true, size: 26 })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
    })
  );

  for (const jour of jours) {
    elements.push(
      new Paragraph({
        children: [new TextRun({ text: `AUDIENCE DU ${formatDateLongue(jour.date).toUpperCase()}`, bold: true, size: 22 })],
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

  // Section separee (voir buildRoleSemainePdf pour la meme justification) :
  // les champs riches d'une audience n'ont pas d'equivalent pour un
  // rdv/appel/tache/echeance de procedure.
  if (input.autresEvenements.length > 0) {
    elements.push(
      new Paragraph({
        children: [new TextRun({ text: "AUTRES ÉVÉNEMENTS DE LA SEMAINE", bold: true, size: 26 })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 300, after: 200 },
      })
    );

    const joursAutres = grouperEvenementsParJour(input.autresEvenements);
    for (const jour of joursAutres) {
      elements.push(
        new Paragraph({
          children: [new TextRun({ text: formatDateLongue(jour.date).toUpperCase(), bold: true, size: 22 })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 120 },
        })
      );
      elements.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: COLONNES_AUTRES_EVENEMENTS.map((c) => docxCell(c, { bold: true, shaded: true })) }),
            ...jour.evenements.map(
              (e) =>
                new TableRow({
                  children: [
                    docxCell(formatHeureEvenement(e)),
                    docxCell(e.type),
                    docxCell(e.titre),
                    docxCell(e.lieu || ""),
                    docxCell(e.description || ""),
                  ],
                })
            ),
          ],
        })
      );
      elements.push(new Paragraph({ text: "", spacing: { after: 200 } }));
    }
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
