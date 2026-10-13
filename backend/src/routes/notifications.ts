import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const notificationsRouter = Router();

const listeQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

notificationsRouter.get("/api/notifications", requireAuth, async (req, res) => {
  const parsed = listeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Filtres invalides", details: parsed.error.issues });
  }
  const notifications = await prisma.notification.findMany({
    where: { destinataireId: req.auth!.userId },
    orderBy: { createdAt: "desc" },
    take: parsed.data.limit ?? 20,
  });
  return res.json(notifications);
});

notificationsRouter.get("/api/notifications/compteur", requireAuth, async (req, res) => {
  const nonLues = await prisma.notification.count({
    where: { destinataireId: req.auth!.userId, lu: false },
  });
  return res.json({ nonLues });
});

notificationsRouter.patch("/api/notifications/:id/lu", requireAuth, async (req, res) => {
  const notification = await prisma.notification.findFirst({
    where: { id: req.params.id, destinataireId: req.auth!.userId },
  });
  if (!notification) {
    return res.status(404).json({ error: "Notification introuvable" });
  }
  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { lu: true, luAt: new Date() },
  });
  return res.json(updated);
});

notificationsRouter.post("/api/notifications/tout-lire", requireAuth, async (req, res) => {
  await prisma.notification.updateMany({
    where: { destinataireId: req.auth!.userId, lu: false },
    data: { lu: true, luAt: new Date() },
  });
  return res.json({ ok: true });
});
