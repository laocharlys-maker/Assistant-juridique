import { Request, Response, NextFunction } from "express";
import { verifyAuthToken, AuthTokenPayload } from "../services/auth";
import { prisma } from "../lib/prisma";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.aurore_session;
  if (!token) {
    res.status(401).json({ error: "Non authentifié" });
    return;
  }

  let payload: AuthTokenPayload;
  try {
    payload = verifyAuthToken(token);
  } catch {
    res.status(401).json({ error: "Session invalide ou expirée" });
    return;
  }

  try {
    // Verifie a chaque requete que le compte n'a pas ete desactive entre
    // temps par l'admin (le token JWT lui-meme reste valide 7 jours), et
    // que l'acces du cabinet n'a pas ete coupe par la plateforme depuis
    // (impaye, resiliation...).
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { actif: true, cabinet: { select: { actif: true, essaiExpireLe: true } } },
    });
    if (!user || !user.actif) {
      res.clearCookie("aurore_session");
      res.status(401).json({ error: "Ce compte a été désactivé." });
      return;
    }
    if (payload.role !== "super_admin") {
      if (!user.cabinet.actif) {
        res.clearCookie("aurore_session");
        res.status(403).json({ error: "L'accès de ce cabinet a été suspendu. Contactez l'administrateur de la plateforme." });
        return;
      }
      if (user.cabinet.essaiExpireLe && user.cabinet.essaiExpireLe.getTime() < Date.now()) {
        res.clearCookie("aurore_session");
        res.status(403).json({ error: "La période d'accès de ce cabinet a expiré. Contactez l'administrateur de la plateforme." });
        return;
      }
    }
  } catch (error) {
    console.error("Erreur lors de la verification du compte", error);
    res.status(500).json({ error: "Erreur interne" });
    return;
  }

  req.auth = payload;
  next();
}
