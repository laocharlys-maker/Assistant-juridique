import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const dossiersRouter = Router();

dossiersRouter.get("/api/dossiers", requireAuth, async (req, res) => {
  const { auth } = req;
  // Un collaborateur ne peut voir que ses propres dossiers ; seul un titulaire
  // peut demander la vue "cabinet" complète.
  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && auth!.role === "titulaire" ? "cabinet" : "mine";

  const dossiers = await prisma.dossier.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      ...(scope === "mine" ? { createdBy: auth!.userId } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { actions: true } }, creePar: { select: { nom: true } } },
  });

  return res.json({ scope, dossiers });
});

dossiersRouter.get("/api/dossiers/:id", requireAuth, async (req, res) => {
  const { auth } = req;

  const dossier = await prisma.dossier.findFirst({
    where: { id: req.params.id, cabinetId: auth!.cabinetId },
    include: {
      creePar: { select: { nom: true } },
      actions: {
        orderBy: { createdAt: "desc" },
        include: { creePar: { select: { nom: true } } },
      },
    },
  });

  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  return res.json(dossier);
});
