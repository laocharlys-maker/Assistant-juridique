import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { creerNotificationsMultiples } from "../services/notifications";

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

const diffusionSchema = z.object({
  titre: z.string().trim().min(1, "Le titre est requis.").max(200),
  message: z.string().trim().min(1, "Le message est requis.").max(5000),
  destinataireIds: z.array(z.string().uuid()).min(1, "Choisis au moins un destinataire."),
});

// Diffusion d'une information a plusieurs membres du cabinet a la fois -
// ouvert a TOUT membre authentifie (titulaire, avocat ou collaborateur),
// choix explicite de l'utilisateur. Reutilise le centre de notifications
// existant (un meme titre/message, une ligne Notification par
// destinataire) plutot qu'un nouveau mecanisme : le ciblage par role (ou
// individuel) est resolu cote client (voir public/js/layout.js), ici on
// valide juste que chaque id correspond bien a un membre actif de CE
// cabinet.
notificationsRouter.post("/api/notifications/diffusion", requireAuth, async (req, res) => {
  const parsed = diffusionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const destinataires = await prisma.user.findMany({
    where: { id: { in: parsed.data.destinataireIds }, cabinetId: req.auth!.cabinetId, actif: true },
    select: { id: true },
  });
  if (destinataires.length === 0) {
    return res.status(400).json({ error: "Aucun destinataire valide dans ce cabinet." });
  }

  await creerNotificationsMultiples(
    destinataires.map((d) => d.id),
    {
      cabinetId: req.auth!.cabinetId,
      type: "diffusion",
      titre: parsed.data.titre,
      message: parsed.data.message,
      creeParId: req.auth!.userId,
    }
  );

  return res.status(201).json({ ok: true, nombreDestinataires: destinataires.length });
});
