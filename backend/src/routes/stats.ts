import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const statsRouter = Router();

// Reserve aux avocats (titulaire pour l'instant ; sera etendu aux autres
// avocats et a l'admin quand ces roles existeront).
function requireAvocat(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== "titulaire") {
    res.status(403).json({ error: "Réservé aux avocats du cabinet" });
    return;
  }
  next();
}

statsRouter.get("/api/stats", requireAuth, requireAvocat, async (req, res) => {
  const cabinetId = req.auth!.cabinetId;

  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [dossiersActifs, crCeMois, echeances7Jours] = await Promise.all([
    prisma.dossier.count({ where: { cabinetId, statut: "actif" } }),
    prisma.action.count({
      where: {
        typeAction: "notes",
        createdAt: { gte: startOfMonth },
        dossier: { cabinetId },
      },
    }),
    prisma.delaiCalcul.count({
      where: {
        dateLimite: { gte: now, lte: in7Days },
        createdBy: { cabinetId },
      },
    }),
  ]);

  return res.json({ dossiersActifs, crCeMois, echeances7Jours });
});
