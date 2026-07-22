import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const cabinetRouter = Router();

function requireTitulaire(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== "titulaire") {
    res.status(403).json({ error: "Réservé au titulaire du cabinet" });
    return;
  }
  next();
}

cabinetRouter.get("/api/cabinet", requireAuth, async (req, res) => {
  const cabinet = await prisma.cabinet.findUnique({
    where: { id: req.auth!.cabinetId },
    select: { id: true, nom: true },
  });
  if (!cabinet) {
    return res.status(404).json({ error: "Cabinet introuvable" });
  }
  return res.json(cabinet);
});

const updateCabinetSchema = z.object({
  nom: z.string().min(1),
});

cabinetRouter.patch("/api/cabinet", requireAuth, requireTitulaire, async (req, res) => {
  const parsed = updateCabinetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Nom invalide" });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: { nom: parsed.data.nom },
  });
  return res.json({ id: cabinet.id, nom: cabinet.nom });
});
