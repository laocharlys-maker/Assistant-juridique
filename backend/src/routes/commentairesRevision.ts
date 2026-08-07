import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { logAuditStep } from "../services/audit";

export const commentairesRevisionRouter = Router();

// Statuts d'Action sur lesquels une remarque peut etre laissee : le document
// est en attente d'un avis (en_attente_validation), ou deja en revision
// (une remarque supplementaire, avant que le collaborateur ait renvoye pour
// validation). Voir README-LOT10.md.
const STATUTS_COMMENTABLES = new Set(["en_attente_validation", "revision_demandee"]);

const commentaireSchema = z.object({
  contenu: z.string().trim().min(1, "La remarque ne peut pas être vide.").max(5000),
});

async function findActionDuCabinet(actionId: string, cabinetId: string) {
  return prisma.action.findFirst({
    where: { id: actionId, dossier: { cabinetId } },
  });
}

// Cree une remarque de revision - reserve aux avocats/titulaire (jamais un
// collaborateur, meme sur ses propres documents). Fait automatiquement
// passer le document en "revision_demandee" s'il ne l'est pas deja.
commentairesRevisionRouter.post(
  "/api/actions/:id/commentaires",
  requireAuth,
  requireModule("revision"),
  async (req, res) => {
    if (req.auth!.role === "collaborateur") {
      return res.status(403).json({ error: "Seul un avocat du cabinet peut laisser une remarque de révision." });
    }

    const parsed = commentaireSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Remarque invalide" });
    }

    const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
    if (!action) {
      return res.status(404).json({ error: "Action introuvable" });
    }
    if (!STATUTS_COMMENTABLES.has(action.statut)) {
      return res.status(409).json({
        error: "Les remarques ne sont possibles que sur un document en attente de validation ou déjà en révision.",
      });
    }

    const commentaire = await prisma.commentaireRevision.create({
      data: { actionId: action.id, auteurId: req.auth!.userId, contenu: parsed.data.contenu },
      include: { auteur: { select: { nom: true } }, resoluPar: { select: { nom: true } } },
    });

    if (action.statut !== "revision_demandee") {
      await prisma.action.update({ where: { id: action.id }, data: { statut: "revision_demandee" } });
    }

    await logAuditStep(
      action.id,
      "remarque_revision",
      "succes",
      `Remarque ajoutée par ${req.auth!.userId} : ${parsed.data.contenu.slice(0, 200)}`
    );

    return res.status(201).json(commentaire);
  }
);

commentairesRevisionRouter.get(
  "/api/actions/:id/commentaires",
  requireAuth,
  requireModule("revision"),
  async (req, res) => {
    const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
    if (!action) {
      return res.status(404).json({ error: "Action introuvable" });
    }

    const commentaires = await prisma.commentaireRevision.findMany({
      where: { actionId: action.id },
      orderBy: { dateCreation: "asc" },
      include: { auteur: { select: { nom: true } }, resoluPar: { select: { nom: true } } },
    });

    return res.json(commentaires);
  }
);

// Marque une remarque resolue - reserve au collaborateur ayant redige le
// document (Action.createdBy) ou a l'auteur de la remarque lui-meme.
commentairesRevisionRouter.patch(
  "/api/actions/:id/commentaires/:commentaireId/resoudre",
  requireAuth,
  requireModule("revision"),
  async (req, res) => {
    const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
    if (!action) {
      return res.status(404).json({ error: "Action introuvable" });
    }

    const commentaire = await prisma.commentaireRevision.findFirst({
      where: { id: req.params.commentaireId, actionId: action.id },
    });
    if (!commentaire) {
      return res.status(404).json({ error: "Remarque introuvable" });
    }
    if (req.auth!.userId !== action.createdBy && req.auth!.userId !== commentaire.auteurId) {
      return res.status(403).json({
        error: "Seul le collaborateur qui a rédigé ce document, ou l'auteur de la remarque, peut la marquer résolue.",
      });
    }
    if (commentaire.statut === "resolu") {
      return res.status(409).json({ error: "Cette remarque est déjà résolue." });
    }

    const updated = await prisma.commentaireRevision.update({
      where: { id: commentaire.id },
      data: { statut: "resolu", dateResolution: new Date(), resoluParId: req.auth!.userId },
      include: { auteur: { select: { nom: true } }, resoluPar: { select: { nom: true } } },
    });

    return res.json(updated);
  }
);

// Transition explicite revision_demandee -> en_attente_validation, bloquee
// tant qu'il reste des remarques ouvertes (le collaborateur doit toutes les
// traiter avant de renvoyer, plutot qu'un renvoi automatique des la
// premiere remarque resolue).
commentairesRevisionRouter.post(
  "/api/actions/:id/renvoyer-validation",
  requireAuth,
  requireModule("revision"),
  async (req, res) => {
    const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
    if (!action) {
      return res.status(404).json({ error: "Action introuvable" });
    }
    if (action.statut !== "revision_demandee") {
      return res.status(409).json({ error: "Ce document n'est pas en révision." });
    }

    const ouverts = await prisma.commentaireRevision.count({ where: { actionId: action.id, statut: "ouvert" } });
    if (ouverts > 0) {
      return res.status(409).json({
        error: `${ouverts} remarque(s) restent ouvertes. Résous-les toutes avant de renvoyer pour validation.`,
      });
    }

    await prisma.action.update({ where: { id: action.id }, data: { statut: "en_attente_validation" } });
    await logAuditStep(action.id, "renvoi_validation", "succes", `Renvoyé pour validation par ${req.auth!.userId}`);

    return res.json({ ok: true });
  }
);
