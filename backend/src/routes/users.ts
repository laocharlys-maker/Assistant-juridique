import { Router, Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { hashPassword } from "../services/auth";

export const usersRouter = Router();

function requireTitulaire(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== "titulaire") {
    res.status(403).json({ error: "Réservé au titulaire du cabinet" });
    return;
  }
  next();
}

const createUserSchema = z.object({
  nom: z.string().min(1),
  email: z.string().email(),
});

// Annuaire minimal du cabinet (id/nom/email/role), accessible a tout membre
// authentifie - utilise par ex. pour choisir un destinataire interne lors
// de l'envoi d'un document, sans exposer la hierarchie ou les acces.
usersRouter.get("/api/users/annuaire", requireAuth, async (req, res) => {
  const users = await prisma.user.findMany({
    where: { cabinetId: req.auth!.cabinetId },
    select: { id: true, nom: true, email: true, role: true },
    orderBy: { nom: "asc" },
  });
  return res.json(users);
});

usersRouter.get("/api/users", requireAuth, requireTitulaire, async (req, res) => {
  const users = await prisma.user.findMany({
    where: { cabinetId: req.auth!.cabinetId },
    select: {
      id: true,
      nom: true,
      email: true,
      role: true,
      createdAt: true,
      responsableId: true,
      partageSignatureActif: true,
      responsable: { select: { id: true, nom: true } },
      accesAccordes: { select: { avocat: { select: { id: true, nom: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  return res.json(users);
});

usersRouter.post("/api/users", requireAuth, requireTitulaire, async (req, res) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const { nom, email } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
  }

  const plainPassword = crypto.randomBytes(9).toString("base64url");
  const user = await prisma.user.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      nom,
      email,
      motDePasseHash: await hashPassword(plainPassword),
      role: "collaborateur",
      // Le collaborateur depend par defaut de l'avocat qui cree son compte.
      responsableId: req.auth!.userId,
    },
  });

  return res.status(201).json({
    id: user.id,
    nom: user.nom,
    email: user.email,
    role: user.role,
    password: plainPassword,
  });
});

// Acces supplementaires : un avocat (titulaire) accorde a un collaborateur
// (pas forcement le sien) le droit de voir ses propres dossiers.
const grantAccessSchema = z.object({
  collaborateurId: z.string().uuid(),
});

usersRouter.post("/api/users/access-grants", requireAuth, requireTitulaire, async (req, res) => {
  const parsed = grantAccessSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const collaborateur = await prisma.user.findFirst({
    where: {
      id: parsed.data.collaborateurId,
      cabinetId: req.auth!.cabinetId,
      role: "collaborateur",
    },
  });
  if (!collaborateur) {
    return res.status(404).json({ error: "Collaborateur introuvable dans ce cabinet" });
  }

  await prisma.accesSupplementaire.upsert({
    where: {
      collaborateurId_avocatId: {
        collaborateurId: collaborateur.id,
        avocatId: req.auth!.userId,
      },
    },
    update: {},
    create: { collaborateurId: collaborateur.id, avocatId: req.auth!.userId },
  });

  return res.status(201).json({ ok: true });
});

usersRouter.delete(
  "/api/users/access-grants/:collaborateurId",
  requireAuth,
  requireTitulaire,
  async (req, res) => {
    await prisma.accesSupplementaire.deleteMany({
      where: { collaborateurId: req.params.collaborateurId, avocatId: req.auth!.userId },
    });
    return res.json({ ok: true });
  }
);

// Un avocat autorise (ou pas) son propre collaborateur direct a inserer sa
// signature lors de l'envoi d'un document. Ne concerne que la relation
// responsable direct <-> collaborateur (pas les acces supplementaires).
const partageSignatureSchema = z.object({
  actif: z.boolean(),
});

usersRouter.patch(
  "/api/users/:id/partage-signature",
  requireAuth,
  requireTitulaire,
  async (req, res) => {
    const parsed = partageSignatureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Requête invalide" });
    }

    const collaborateur = await prisma.user.findFirst({
      where: {
        id: req.params.id,
        cabinetId: req.auth!.cabinetId,
        role: "collaborateur",
        responsableId: req.auth!.userId,
      },
    });
    if (!collaborateur) {
      return res.status(404).json({ error: "Ce collaborateur ne dépend pas de toi" });
    }

    await prisma.user.update({
      where: { id: collaborateur.id },
      data: { partageSignatureActif: parsed.data.actif },
    });
    return res.json({ ok: true });
  }
);
