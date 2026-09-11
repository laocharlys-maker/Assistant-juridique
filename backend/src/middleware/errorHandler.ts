import { Request, Response, NextFunction } from "express";

/**
 * Filet de securite final (4 arguments = middleware d'erreur Express) :
 * toute erreur (synchrone OU rejet de promesse) levee dans une route est
 * transmise ici par express-async-errors (voir l'import tout en haut de
 * app.ts) au lieu de faire planter tout le process. Une seule requete
 * echoue avec un 500 - toutes les autres fonctionnalites/utilisateurs en
 * cours continuent de fonctionner normalement. Le filet
 * process.on("uncaughtException"/"unhandledRejection") de index.ts reste en
 * place pour de vraies pannes hors du cycle requete/reponse (ex: un job
 * planifie comme la veille juridique).
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  console.error(`[erreur-requete] ${req.method} ${req.path} :`, err instanceof Error ? err.stack || err.message : err);
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: "Une erreur inattendue est survenue. Réessaie dans un instant." });
}
