import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAvocat } from "../middleware/roles";
import { getAccessibleAvocatIds } from "../services/access";

export const statsRouter = Router();

statsRouter.get("/api/stats", requireAuth, requireAvocat, async (req, res) => {
  const cabinetId = req.auth!.cabinetId;

  // L'admin (titulaire) voit les stats de tout le cabinet ; un avocat ne
  // voit que les siennes (ses propres dossiers + ceux de ses
  // collaborateurs).
  const accessibleAvocatIds =
    req.auth!.role === "titulaire" ? null : await getAccessibleAvocatIds(req.auth!);

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

  return res.json({ dossiersActifs, crCeMois, echeances7Jours });
});
