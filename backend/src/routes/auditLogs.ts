import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/roles";

export const auditLogsRouter = Router();

const querySchema = z.object({
  statut: z.enum(["succes", "erreur"]).optional(),
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
  const { statut, limit } = parsed.data;

  const logs = await prisma.auditLog.findMany({
    where: {
      statut,
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
