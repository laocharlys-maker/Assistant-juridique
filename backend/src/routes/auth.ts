import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { verifyPassword, signAuthToken } from "../services/auth";
import { requireAuth } from "../middleware/requireAuth";
import { env } from "../config/env";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/api/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Email ou mot de passe invalide" });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return res.status(401).json({ error: "Identifiants incorrects" });
  }

  const validPassword = await verifyPassword(password, user.motDePasseHash);
  if (!validPassword) {
    return res.status(401).json({ error: "Identifiants incorrects" });
  }

  const token = signAuthToken({ userId: user.id, cabinetId: user.cabinetId, role: user.role });

  res.cookie("aurore_session", token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({ id: user.id, nom: user.nom, email: user.email, role: user.role });
});

authRouter.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("aurore_session");
  return res.json({ ok: true });
});

authRouter.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: {
      id: true,
      nom: true,
      email: true,
      role: true,
      cabinetId: true,
      signatureUrl: true,
      partageSignatureActif: true,
      responsable: { select: { nom: true, signatureUrl: true } },
    },
  });
  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  const peutUtiliserSignatureResponsable =
    user.role === "collaborateur" && user.partageSignatureActif && !!user.responsable?.signatureUrl;

  return res.json({
    ...user,
    responsable: user.responsable ? { nom: user.responsable.nom } : null,
    peutUtiliserSignatureResponsable,
  });
});
