import { Request, Response, NextFunction } from "express";
import { verifyAuthToken, AuthTokenPayload } from "../services/auth";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthTokenPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.aurore_session;
  if (!token) {
    res.status(401).json({ error: "Non authentifié" });
    return;
  }

  try {
    req.auth = verifyAuthToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Session invalide ou expirée" });
  }
}
