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

usersRouter.get("/api/users", requireAuth, requireTitulaire, async (req, res) => {
  const users = await prisma.user.findMany({
    where: { cabinetId: req.auth!.cabinetId },
    select: { id: true, nom: true, email: true, role: true, createdAt: true },
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
