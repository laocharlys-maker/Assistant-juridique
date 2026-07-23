import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/roles";

export const auditLogsRouter = Router();

const querySchema = z.object({
  statut: z.enum(["succes", "erreur"]).optional(),
  // Ne renvoie que les entrees des N derniers mois (permet de "classer" par
  // periode) - absent = pas de filtre de date.
  depuisMois: z.coerce.number().int().positive().max(60).optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

// Journal d'audit du cabinet : chaque etape technique (extraction IA,
// declenchement n8n...) d'une action, avec son statut. Reserve a l'admin -
// c'est un outil de suivi/securite, pas une donnee metier courante.
auditLogsRouter.get("/api/audit-logs", requireAuth, requireAdmin, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const { statut, depuisMois, limit } = parsed.data;

  const depuisDate = depuisMois
    ? new Date(new Date().setMonth(new Date().getMonth() - depuisMois))
    : undefined;

  const logs = await prisma.auditLog.findMany({
    where: {
      statut,
      timestamp: depuisDate ? { gte: depuisDate } : undefined,
      action: { dossier: { cabinetId: req.auth!.cabinetId } },
    },
    include: {
      action: {
        select: {
          typeAction: true,
          canal: true,
          dossier: { select: { numeroDossier: true, nomAffaire: true } },
        },
      },
    },
    orderBy: { timestamp: "desc" },
    take: limit,
  });

  return res.json(
    logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      etape: log.etape,
      statut: log.statut,
      detail: log.detail,
      typeAction: log.action.typeAction,
      canal: log.action.canal,
      numeroDossier: log.action.dossier.numeroDossier,
      nomAffaire: log.action.dossier.nomAffaire,
    }))
  );
});

const purgeQuerySchema = z.object({
  // Supprime les entrees STRICTEMENT PLUS VIEILLES que N mois - jamais les
  // plus recentes, pour alleger la liste sans perdre l'historique utile.
  plusVieuxQueMois: z.coerce.number().int().positive().max(60),
});

auditLogsRouter.delete("/api/audit-logs", requireAuth, requireAdmin, async (req, res) => {
  const parsed = purgeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const cutoff = new Date(new Date().setMonth(new Date().getMonth() - parsed.data.plusVieuxQueMois));

  const { count } = await prisma.auditLog.deleteMany({
    where: {
      timestamp: { lt: cutoff },
      action: { dossier: { cabinetId: req.auth!.cabinetId } },
    },
  });
  return res.json({ deleted: count });
});
