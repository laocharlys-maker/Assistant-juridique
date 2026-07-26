import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAvocat } from "../middleware/roles";

export const huissiersRouter = Router();

// Annuaire des huissiers du cabinet : consultable par tous (pour choisir un
// destinataire lors de l'envoi d'une Assignation / Mise en demeure), mais
// gere uniquement par un avocat/titulaire.
huissiersRouter.get("/api/huissiers", requireAuth, async (req, res) => {
  const huissiers = await prisma.huissier.findMany({
    where: { cabinetId: req.auth!.cabinetId },
    orderBy: { nom: "asc" },
  });
  return res.json(huissiers);
});

const huissierSchema = z.object({
  nom: z.string().min(1),
  email: z.string().email(),
  telephone: z.string().optional(),
});

huissiersRouter.post("/api/huissiers", requireAuth, requireAvocat, async (req, res) => {
  const parsed = huissierSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const huissier = await prisma.huissier.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      nom: parsed.data.nom,
      email: parsed.data.email,
      telephone: parsed.data.telephone || null,
    },
  });
  return res.status(201).json(huissier);
});

huissiersRouter.delete("/api/huissiers/:id", requireAuth, requireAvocat, async (req, res) => {
  const huissier = await prisma.huissier.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!huissier) {
    return res.status(404).json({ error: "Huissier introuvable" });
  }
  await prisma.huissier.delete({ where: { id: huissier.id } });
  return res.json({ ok: true });
});
