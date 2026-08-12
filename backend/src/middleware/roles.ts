import { Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";

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

// Reserve au compte plateforme (exploitant d'Aurore) : gere la liste des
// cabinets clients, jamais les donnees metier d'un cabinet.
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.role !== "super_admin") {
    res.status(403).json({ error: "Réservé à l'administration de la plateforme" });
    return;
  }
  next();
}

// Bloque l'acces a un module que la plateforme a desactive pour ce cabinet
// (formule souscrite), OU que le titulaire a retire pour CE collaborateur
// precis (User.modulesDesactives) - deux reglages independants, verifies
// tous les deux : le premier (plateforme) prime toujours, le second
// (titulaire) ne peut jamais l'outrepasser, uniquement restreindre en plus.
// A poser sur les routeurs correspondant a un module vendable separement
// (factures, jurisprudence, delais...).
export function requireModule(cle: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Sans try/catch, une erreur Postgres ici (middleware partage par tous
    // les modules payants - facturation, jurisprudence, delais...) resterait
    // une promesse rejetee non rattrapee, qui arrete TOUT le backend via le
    // filet de securite process.on("unhandledRejection", ...) de index.ts -
    // un rayon d'action disproportionne pour une simple verification
    // d'acces a un module.
    try {
      const cabinet = await prisma.cabinet.findUnique({
        where: { id: req.auth!.cabinetId },
        select: { modulesDesactives: true },
      });
      if (cabinet?.modulesDesactives.includes(cle)) {
        res.status(403).json({ error: "Ce module n'est pas activé pour votre cabinet. Contactez l'administrateur de la plateforme." });
        return;
      }

      const user = await prisma.user.findUnique({
        where: { id: req.auth!.userId },
        select: { modulesDesactives: true },
      });
      if (user?.modulesDesactives.includes(cle)) {
        res.status(403).json({ error: "Ce module n'est pas activé pour ton compte. Contacte le titulaire du cabinet." });
        return;
      }

      next();
    } catch (error) {
      console.error(`Erreur verification du module "${cle}" :`, error);
      res.status(500).json({ error: "Erreur interne (voir logs serveur)" });
    }
  };
}
