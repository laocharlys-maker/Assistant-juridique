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

  const sixMoisAvant = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));

  const [dossiersActifs, crCeMois, echeances7Jours, actionsRecentes] = await Promise.all([
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
    prisma.action.findMany({
      where: {
        createdAt: { gte: sixMoisAvant },
        dossier: {
          cabinetId,
          ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
        },
      },
      select: { createdAt: true, typeAction: true },
    }),
  ]);

  // Evolution mensuelle (6 derniers mois, y compris les mois sans activite),
  // avec le detail par type de document pour permettre au tableau de bord
  // d'afficher la tendance globale ou filtree sur un seul type.
  const evolutionMensuelle: { mois: string; total: number; parType: Record<string, number> }[] = [];
  for (let i = 5; i >= 0; i--) {
    const moisDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const cle = `${moisDate.getUTCFullYear()}-${String(moisDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const label = moisDate.toLocaleDateString("fr-FR", { month: "short", timeZone: "UTC" });
    const actionsDuMois = actionsRecentes.filter((a) => {
      const d = a.createdAt;
      return d.getUTCFullYear() === moisDate.getUTCFullYear() && d.getUTCMonth() === moisDate.getUTCMonth();
    });
    const parType: Record<string, number> = {};
    for (const a of actionsDuMois) {
      parType[a.typeAction] = (parType[a.typeAction] ?? 0) + 1;
    }
    evolutionMensuelle.push({ mois: `${cle}|${label}`, total: actionsDuMois.length, parType });
  }

  // Repartition par type de document (6 derniers mois), triee par volume.
  const compteParType = new Map<string, number>();
  for (const a of actionsRecentes) {
    compteParType.set(a.typeAction, (compteParType.get(a.typeAction) ?? 0) + 1);
  }
  const repartitionTypes = Array.from(compteParType.entries())
    .map(([type, total]) => ({ type, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  return res.json({
    scope: requestedScope,
    dossiersActifs,
    crCeMois,
    echeances7Jours,
    evolutionMensuelle,
    repartitionTypes,
  });
});
