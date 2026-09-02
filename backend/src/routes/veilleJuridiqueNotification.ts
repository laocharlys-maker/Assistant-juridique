import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAvocat } from "../middleware/roles";

export const veilleJuridiqueNotificationRouter = Router();

/**
 * Notification in-app du dernier digest de veille juridique (voir
 * services/veilleJuridique.ts, runVeilleForCabinet - cree un Action
 * typeAction="veille_juridique" a chaque envoi reussi) - EN PLUS de
 * l'email deja existant, jamais a sa place : ne modifie rien a l'envoi
 * email lui-meme. Sert la pop-up de public/js/layout.js.
 *
 * Memes destinataires que l'email (requireAvocat = titulaire/avocat,
 * recoitVeille) - inutile de notifier quelqu'un qui a explicitement
 * choisi de ne plus recevoir la veille.
 */
veilleJuridiqueNotificationRouter.get(
  "/api/veille-juridique/derniere",
  requireAuth,
  requireAvocat,
  async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      select: { veilleDerniereVue: true, recoitVeille: true },
    });
    if (!user?.recoitVeille) {
      return res.json({ digest: null });
    }

    const derniere = await prisma.action.findFirst({
      where: { typeAction: "veille_juridique", dossier: { cabinetId: req.auth!.cabinetId } },
      orderBy: { createdAt: "desc" },
      select: { dossierId: true, createdAt: true, dossier: { select: { nomAffaire: true } } },
    });
    if (!derniere) {
      return res.json({ digest: null });
    }

    const vue = Boolean(user.veilleDerniereVue && user.veilleDerniereVue >= derniere.createdAt);
    return res.json({
      digest: {
        dossierId: derniere.dossierId,
        titre: derniere.dossier.nomAffaire,
        createdAt: derniere.createdAt,
        vue,
      },
    });
  }
);

// Marque le dernier digest comme vu pour CET utilisateur - sans effet sur
// recoitVeille ni sur l'envoi email (voir schema.prisma, veilleDerniereVue).
veilleJuridiqueNotificationRouter.post(
  "/api/veille-juridique/vue",
  requireAuth,
  requireAvocat,
  async (req, res) => {
    const derniere = await prisma.action.findFirst({
      where: { typeAction: "veille_juridique", dossier: { cabinetId: req.auth!.cabinetId } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (derniere) {
      await prisma.user.update({ where: { id: req.auth!.userId }, data: { veilleDerniereVue: derniere.createdAt } });
    }
    return res.json({ ok: true });
  }
);
