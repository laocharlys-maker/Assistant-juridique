import { Request, Response, NextFunction } from "express";

// Reserve a l'administrateur du cabinet (role "titulaire" en base -
// c'est aussi lui qui a ses propres dossiers en tant qu'avocat, mais
// seul lui peut creer des comptes avocat ou donner un acces "tous les
// dossiers" a un collaborateur).
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== "titulaire") {
    res.status(403).json({ error: "Réservé à l'administrateur du cabinet" });
    return;
  }
  next();
}

// Reserve aux avocats (admin inclus) : role different de "collaborateur".
export function requireAvocat(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== "titulaire" && req.auth?.role !== "avocat") {
    res.status(403).json({ error: "Réservé aux avocats du cabinet" });
    return;
  }
  next();
}
