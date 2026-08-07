import { Request, Response, NextFunction } from "express";
import { Action } from "@prisma/client";
import { prisma } from "../lib/prisma";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Charge par verifierVerrou() - evite une seconde requete identique
      // dans le handler de route qui suit.
      actionVerrouillee?: Action;
    }
  }
}

/**
 * Pose sur POST /api/actions/:id/versions (sauvegarde d'une version) :
 * verifie que l'utilisateur courant detient bien le verrou d'edition de ce
 * document avant d'autoriser l'enregistrement - jamais sur la lecture de
 * l'historique, toujours consultable sans detenir le verrou. Voir
 * README-LOT11.md.
 */
export async function verifierVerrou(req: Request, res: Response, next: NextFunction): Promise<void> {
  const action = await prisma.action.findFirst({
    where: { id: req.params.id, dossier: { cabinetId: req.auth!.cabinetId } },
  });
  if (!action) {
    res.status(404).json({ error: "Action introuvable" });
    return;
  }
  if (action.verrouillePar !== req.auth!.userId) {
    res.status(403).json({
      error: action.verrouillePar
        ? "Tu ne détiens pas le verrou d'édition de ce document — ouvre d'abord \"Modifier\"."
        : "Ouvre d'abord l'édition de ce document (\"Modifier\") avant d'enregistrer une version.",
    });
    return;
  }

  req.actionVerrouillee = action;
  next();
}
