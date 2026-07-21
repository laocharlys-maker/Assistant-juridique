import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { getAccessibleAvocatIds } from "../services/access";

export const dossiersRouter = Router();

dossiersRouter.get("/api/dossiers", requireAuth, async (req, res) => {
  const { auth } = req;
  // Un collaborateur ne peut jamais demander la vue "cabinet" complète ;
  // seul un titulaire le peut.
  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && auth!.role === "titulaire" ? "cabinet" : "mine";

  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth!) : null;

  const dossiers = await prisma.dossier.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { actions: true } }, creePar: { select: { nom: true } } },
  });

  return res.json({ scope, dossiers });
});

dossiersRouter.get("/api/dossiers/:id", requireAuth, async (req, res) => {
  const { auth } = req;

  // Un titulaire voit tout le cabinet ; un collaborateur seulement les
  // dossiers des avocats auxquels il a accès.
  const accessibleAvocatIds =
    auth!.role === "titulaire" ? null : await getAccessibleAvocatIds(auth!);

  const dossier = await prisma.dossier.findFirst({
    where: {
      id: req.params.id,
      cabinetId: auth!.cabinetId,
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
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
