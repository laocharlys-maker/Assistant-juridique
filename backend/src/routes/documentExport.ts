import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { buildDocx, buildPdf } from "../services/documentExport";

export const documentExportRouter = Router();

const TYPE_LABELS: Record<string, string> = {
  notes: "Compte-rendu d'audience",
  redac: "Plaidoirie",
  conclusions: "Conclusions",
  assignation: "Assignation",
  mise_en_demeure: "Mise en demeure",
  jurisprudence: "Recherche de jurisprudence",
};

const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

async function loadExportInput(actionId: string, cabinetId: string) {
  const action = await prisma.action.findFirst({
    where: { id: actionId, dossier: { cabinetId } },
    include: { dossier: { include: { cabinet: true } }, creePar: { select: { nom: true } } },
  });
  if (!action || !action.contenuGenere) return null;

  return {
    action,
    input: {
      cabinetNom: action.dossier.cabinet.nom,
      numeroDossier: action.dossier.numeroDossier,
      nomAffaire: action.dossier.nomAffaire,
      typeLabel: TYPE_LABELS[action.typeAction] || action.typeAction,
      contenu: action.contenuGenere,
      auteurNom: action.creePar.nom,
      date: action.createdAt,
    },
  };
}

documentExportRouter.get("/api/actions/:id/word", requireAuth, async (req, res) => {
  const loaded = await loadExportInput(req.params.id, req.auth!.cabinetId);
  if (!loaded) {
    return res.status(404).json({ error: "Document introuvable" });
  }

  const buffer = await buildDocx(loaded.input);
  const filename = `${slugify(loaded.input.typeLabel)}-${slugify(loaded.input.numeroDossier)}.docx`;
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(buffer);
});

documentExportRouter.get("/api/actions/:id/pdf", requireAuth, async (req, res) => {
  const loaded = await loadExportInput(req.params.id, req.auth!.cabinetId);
  if (!loaded) {
    return res.status(404).json({ error: "Document introuvable" });
  }

  const buffer = await buildPdf(loaded.input);
  const filename = `${slugify(loaded.input.typeLabel)}-${slugify(loaded.input.numeroDossier)}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.send(buffer);
});
