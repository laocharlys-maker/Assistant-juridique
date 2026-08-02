import { Request, Response, NextFunction } from "express";
import { getCurrentLicenceStatus } from "../security/licenceManager";

/**
 * Prefixes d'API toujours accessibles, meme sans licence valide :
 * - /api/licence/* : l'ecran d'activation doit pouvoir consulter le statut,
 *   activer une licence et forcer une verification, quel que soit l'etat
 *   actuel (c'est justement le seul moyen de sortir de l'etat bloque).
 * - /health : sonde de demarrage du sidecar Tauri (voir README-LOT1.md) -
 *   ne doit jamais dependre de la licence pour repondre.
 * - /api/network-info : ecran de premier lancement (choix du mode de
 *   deploiement, Lot 6), qui doit rester accessible avant meme l'activation
 *   de la licence - et affichage IP/hostname pour les postes du reseau.
 * Les pages HTML/CSS/JS statiques (dont l'ecran d'activation lui-meme) ne
 * passent jamais par ce middleware : elles sont servies par
 * express.static, hors du prefixe /api, avant meme d'atteindre ce code.
 */
const PREFIXES_TOUJOURS_ACCESSIBLES = ["/api/licence", "/health", "/api/network-info"];

function estToujoursAccessible(path: string): boolean {
  return PREFIXES_TOUJOURS_ACCESSIBLES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export async function requireLicence(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.path.startsWith("/api") || estToujoursAccessible(req.path)) {
    next();
    return;
  }

  if (process.env.LICENCE_BYPASS === "true") {
    if (process.env.NODE_ENV === "production") {
      // Garde-fou : LICENCE_BYPASS ne doit JAMAIS avoir d'effet en
      // production, meme active par erreur - avertissement bruyant plutot
      // qu'un contournement silencieux de la licence. Voir README-LOT3.md.
      console.error(
        "[licence] LICENCE_BYPASS=true est actif alors que NODE_ENV=production - IGNORE. " +
          "Ce reglage ne doit servir qu'en developpement local."
      );
    } else {
      next();
      return;
    }
  }

  const status = await getCurrentLicenceStatus();
  if (status.etat === "valide" || status.etat === "grace") {
    // Accessible aux routes qui voudraient afficher le bandeau d'alerte
    // sans refaire un appel a /api/licence/status.
    res.locals.licenceStatus = status;
    next();
    return;
  }

  res.status(403).json({
    error: status.messageUtilisateur,
    licenceEtat: status.etat,
  });
}
