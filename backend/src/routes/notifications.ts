import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { creerNotification, creerNotificationsMultiples } from "../services/notifications";

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
    include: { creePar: { select: { nom: true } } },
  });
  // Auteur affiche au destinataire (demande utilisateur du 2026-10-13) -
  // "creeParNom" plutot que l'objet relation complet, pour que le frontend
  // n'ait rien de plus a deballer.
  return res.json(notifications.map((n) => ({ ...n, creeParNom: n.creePar?.nom ?? null, creePar: undefined })));
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

const repondreSchema = z.object({
  message: z.string().trim().min(1, "Le message est requis.").max(2000),
});

// Reponse rapide a une notification (2026-10-13) - une simple nouvelle
// Notification adressee a l'auteur d'origine (type "reponse"), jamais une
// vraie structure de fil de discussion : pas de champ supplementaire, pas
// de migration. Impossible si l'auteur d'origine est inconnu (notification
// generee par un automatisme - ex: rappel de stage, cron) : rien a quoi
// repondre dans ce cas.
notificationsRouter.post("/api/notifications/:id/repondre", requireAuth, async (req, res) => {
  const parsed = repondreSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Message invalide", details: parsed.error.issues });
  }

  const notification = await prisma.notification.findFirst({
    where: { id: req.params.id, destinataireId: req.auth!.userId },
  });
  if (!notification) {
    return res.status(404).json({ error: "Notification introuvable" });
  }
  if (!notification.creeParId) {
    return res.status(400).json({ error: "Cette notification n'a pas d'auteur connu - impossible d'y répondre." });
  }

  const moi = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { nom: true } });

  await creerNotification({
    cabinetId: req.auth!.cabinetId,
    destinataireId: notification.creeParId,
    type: "reponse",
    titre: `Réponse de ${moi.nom}`,
    message: parsed.data.message,
    lienUrl: notification.lienUrl,
    creeParId: req.auth!.userId,
  });

  return res.status(201).json({ ok: true });
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
