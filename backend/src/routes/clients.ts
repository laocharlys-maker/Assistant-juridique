import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const clientsRouter = Router();

clientsRouter.get("/api/clients", requireAuth, async (req, res) => {
  const clients = await prisma.client.findMany({
    where: { cabinetId: req.auth!.cabinetId },
    orderBy: { nom: "asc" },
    include: { _count: { select: { dossiers: true } } },
  });
  return res.json(clients);
});

const createClientSchema = z.object({
  nom: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  telephone: z.string().optional(),
  notes: z.string().optional(),
});

clientsRouter.post("/api/clients", requireAuth, async (req, res) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const client = await prisma.client.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      nom: parsed.data.nom,
      email: parsed.data.email || null,
      telephone: parsed.data.telephone || null,
      notes: parsed.data.notes || null,
    },
  });

  return res.status(201).json(client);
});

clientsRouter.get("/api/clients/:id", requireAuth, async (req, res) => {
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
    include: { dossiers: { orderBy: { updatedAt: "desc" } } },
  });
  if (!client) {
    return res.status(404).json({ error: "Client introuvable" });
  }
  return res.json(client);
});
