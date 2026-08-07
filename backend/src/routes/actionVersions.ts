import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { verifierVerrou } from "../middleware/verifierVerrou";
import { logAuditStep } from "../services/audit";
import { verrouTimeoutMs } from "../jobs/liberationVerrousExpires";

export const actionVersionsRouter = Router();

async function findActionDuCabinet(actionId: string, cabinetId: string) {
  return prisma.action.findFirst({
    where: { id: actionId, dossier: { cabinetId } },
  });
}

// Ouvre l'edition ("Modifier") : prend le verrou si libre, deja detenu par
// soi-meme, ou expire (voir jobs/liberationVerrousExpires.ts) - sinon 409
// avec un message clair identifiant qui le detient et depuis quand.
actionVersionsRouter.post("/api/actions/:id/verrou", requireAuth, async (req, res) => {
  const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }

  // Lot 11 (Partie A) : un document deja valide ne peut pas etre rouvert en
  // edition directement - il faut d'abord repasser par une revision demandee
  // (Lot 10), jamais un ecrasement silencieux de la version validee.
  if (action.statut === "valide" || action.statut === "envoye") {
    return res.status(409).json({
      error: "Ce document est validé : une remarque de révision doit d'abord le repasser en révision avant de pouvoir le modifier.",
    });
  }

  const verrouExpire =
    action.verrouilleLe !== null && action.verrouilleLe.getTime() < Date.now() - verrouTimeoutMs();

  if (action.verrouillePar && action.verrouillePar !== req.auth!.userId && !verrouExpire) {
    const detenteur = await prisma.user.findUnique({ where: { id: action.verrouillePar }, select: { nom: true } });
    return res.status(409).json({
      error: `Ce document est en cours de modification par ${detenteur?.nom || "un autre utilisateur"} depuis ${action.verrouilleLe!.toLocaleString("fr-FR")}.`,
    });
  }

  const updated = await prisma.action.update({
    where: { id: action.id },
    data: { verrouillePar: req.auth!.userId, verrouilleLe: new Date() },
  });
  await logAuditStep(action.id, "verrou_pris", "succes", `Édition ouverte par ${req.auth!.userId}`);
  return res.json({ verrouillePar: updated.verrouillePar, verrouilleLe: updated.verrouilleLe });
});

// Ferme l'edition ("Terminer l'édition") : libere explicitement le verrou -
// jamais dependant de la seule fermeture d'onglet/navigateur.
actionVersionsRouter.delete("/api/actions/:id/verrou", requireAuth, async (req, res) => {
  const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }
  if (action.verrouillePar !== req.auth!.userId) {
    return res.status(403).json({ error: "Tu ne détiens pas le verrou d'édition de ce document." });
  }

  await prisma.action.update({ where: { id: action.id }, data: { verrouillePar: null, verrouilleLe: null } });
  await logAuditStep(action.id, "verrou_libere", "succes", `Édition terminée par ${req.auth!.userId}`);
  return res.json({ ok: true });
});

const versionSchema = z.object({
  contenu: z.string().min(1, "Le contenu ne peut pas être vide."),
});

// Sauvegarde explicite d'une version - jamais d'autosave en continu.
// N'ecrit PAS Action.contenuGenere (qui reflete toujours la derniere
// version VALIDEE, pas la derniere version enregistree) : voir
// README-LOT11.md. Reserve a qui detient le verrou (verifierVerrou).
actionVersionsRouter.post("/api/actions/:id/versions", requireAuth, verifierVerrou, async (req, res) => {
  const parsed = versionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Contenu invalide" });
  }

  const action = req.actionVerrouillee!;
  const numero = action.versionActuelle + 1;

  const [version] = await prisma.$transaction([
    prisma.actionVersion.create({
      data: { actionId: action.id, numero, contenu: parsed.data.contenu, auteurId: req.auth!.userId },
      include: { auteur: { select: { nom: true } } },
    }),
    prisma.action.update({ where: { id: action.id }, data: { versionActuelle: numero } }),
  ]);

  await logAuditStep(action.id, "version_enregistree", "succes", `Version ${numero} enregistrée par ${req.auth!.userId}`);
  return res.status(201).json(version);
});

actionVersionsRouter.get("/api/actions/:id/versions", requireAuth, async (req, res) => {
  const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }

  const versions = await prisma.actionVersion.findMany({
    where: { actionId: action.id },
    orderBy: { numero: "desc" },
    include: { auteur: { select: { nom: true } } },
  });
  return res.json(versions);
});

// Valide UNE version precise : la fige comme reference (Action.contenuGenere
// mis a jour avec son contenu, Action.statut -> "valide"), jamais un
// collaborateur, jamais si des remarques de revision restent ouvertes
// (meme regle que POST /api/actions/:id/valider, Lot 10).
actionVersionsRouter.post("/api/actions/:id/versions/:versionId/valider", requireAuth, async (req, res) => {
  if (req.auth!.role === "collaborateur") {
    return res.status(403).json({ error: "Seul un avocat du cabinet peut valider une version." });
  }

  const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }

  const version = await prisma.actionVersion.findFirst({
    where: { id: req.params.versionId, actionId: action.id },
  });
  if (!version) {
    return res.status(404).json({ error: "Version introuvable" });
  }
  if (version.estVersionValidee) {
    return res.status(409).json({ error: "Cette version est déjà la version validée." });
  }

  const commentairesOuverts = await prisma.commentaireRevision.count({
    where: { actionId: action.id, statut: "ouvert" },
  });
  if (commentairesOuverts > 0) {
    return res.status(409).json({
      error: `Ce document a ${commentairesOuverts} remarque(s) de révision non résolue(s) : il ne peut pas être validé tant qu'elles restent ouvertes.`,
    });
  }

  await prisma.$transaction([
    prisma.actionVersion.updateMany({
      where: { actionId: action.id, estVersionValidee: true },
      data: { estVersionValidee: false },
    }),
    prisma.actionVersion.update({ where: { id: version.id }, data: { estVersionValidee: true } }),
    prisma.action.update({ where: { id: action.id }, data: { contenuGenere: version.contenu, statut: "valide" } }),
  ]);

  await logAuditStep(action.id, "version_validee", "succes", `Version ${version.numero} validée par ${req.auth!.userId}`);
  return res.json({ ok: true });
});
