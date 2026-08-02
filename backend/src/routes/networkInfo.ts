import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/roles";
import { readDeploymentConfig, writeDeploymentMode, getLocalNetworkAddress, isSetupComplete } from "../config/deploymentMode";
import { AURORE_LOCAL_HOSTNAME } from "../network/mdnsAdvertise";

export const networkInfoRouter = Router();

/**
 * GET /api/network-info - toujours accessible (voir middleware/
 * requireLicence.ts), aucune authentification requise : sert a la fois a
 * l'ecran de premier lancement (setup-mode.html, avant toute session/
 * licence) et a l'affichage de l'IP/nom d'hote pour connecter les autres
 * postes du cabinet. Ne contient aucune donnee sensible (IP LAN, port,
 * mode - jamais un secret).
 */
networkInfoRouter.get("/api/network-info", (_req, res) => {
  const config = readDeploymentConfig();
  const localNetwork = getLocalNetworkAddress();
  const port = Number(process.env.PORT) || 3000;

  res.json({
    deploymentMode: config.deploymentMode,
    setupComplete: config.deploymentMode !== null,
    localIp: localNetwork?.address ?? null,
    hostname: AURORE_LOCAL_HOSTNAME,
    port,
    https: config.deploymentMode === "reseau",
  });
});

/**
 * Le tout premier choix (ecran de setup, personne n'est encore connecte)
 * ne requiert aucune authentification - exactement comme l'activation de
 * licence (Lot 3). Une fois ce choix deja fait une premiere fois, le
 * modifier est une decision d'administration du cabinet (ex: passer de
 * "poste unique" a "serveur reseau" apres coup) et exige donc une session
 * titulaire, pour qu'un poste quelconque du reseau local ne puisse pas
 * reconfigurer le serveur a distance sans etre authentifie.
 */
async function requireAdminIfAlreadyConfigured(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isSetupComplete()) {
    next();
    return;
  }
  await requireAuth(req, res, () => requireAdmin(req, res, next));
}

const modeSchema = z.object({ mode: z.enum(["standalone", "reseau"]) }).strict();

networkInfoRouter.post("/api/network-info/mode", requireAdminIfAlreadyConfigured, (req, res) => {
  const parsed = modeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Mode de déploiement invalide." });
    return;
  }

  const config = writeDeploymentMode(parsed.data.mode);

  res.json({
    deploymentMode: config.deploymentMode,
    setupComplete: true,
    // Le binding reseau (127.0.0.1 <-> 0.0.0.0) et le protocole (HTTP <->
    // HTTPS) sont decides une seule fois, au demarrage du process (voir
    // index.ts) - changer le fichier de config ne rebind pas le serveur en
    // cours d'execution. Le frontend doit donc explicitement inviter a
    // redemarrer Aurore.
    redemarrageRequis: true,
  });
});
