import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAvocat } from "../middleware/roles";
import { getAccessibleAvocatIds } from "../services/access";

export const statsRouter = Router();

statsRouter.get("/api/stats", requireAuth, requireAvocat, async (req, res) => {
  const cabinetId = req.auth!.cabinetId;

  // Par defaut : l'admin (titulaire) voit tout le cabinet, un avocat ne
  // voit que les siennes. Chacun peut basculer explicitement via
  // ?scope=mine|cabinet.
  const defaultScope = req.auth!.role === "titulaire" ? "cabinet" : "mine";
  const requestedScope = req.query.scope === "mine" || req.query.scope === "cabinet"
    ? req.query.scope
    : defaultScope;

  const accessibleAvocatIds =
    requestedScope === "cabinet" ? null : await getAccessibleAvocatIds(req.auth!);

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [dossiersActifs, crCeMois, echeances7Jours] = await Promise.all([
    prisma.dossier.count({
      where: {
        cabinetId,
        statut: "actif",
        ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
      },
    }),
    prisma.action.count({
      where: {
        typeAction: "notes",
        createdAt: { gte: startOfMonth },
        dossier: {
          cabinetId,
          ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
        },
      },
    }),
    prisma.delaiCalcul.count({
      where: {
        dateLimite: { gte: now, lte: in7Days },
        createdBy: { cabinetId },
        // Un calcul lie a un dossier est compte pour l'avocat proprietaire
        // du dossier ; un calcul independant (pas de dossier), pour son
        // auteur.
        ...(accessibleAvocatIds
          ? {
              OR: [
                { dossier: { createdBy: { in: accessibleAvocatIds } } },
                { createdById: { in: accessibleAvocatIds } },
              ],
            }
          : {}),
      },
    }),
  ]);

  return res.json({ scope: requestedScope, dossiersActifs, crCeMois, echeances7Jours });
});
