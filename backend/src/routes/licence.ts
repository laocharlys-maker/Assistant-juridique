import { Router } from "express";
import { z } from "zod";
import { activateLicence, getCurrentLicenceStatus, LicenceError, runPhoneHomeCheck } from "../security/licenceManager";

export const licenceRouter = Router();

// Toujours accessible (voir middleware/requireLicence.ts) - c'est ce que
// l'ecran d'activation interroge au chargement pour savoir quoi afficher.
licenceRouter.get("/api/licence/status", async (_req, res) => {
  const status = await getCurrentLicenceStatus();
  res.json(status);
});

const activateSchema = z.object({
  // Contenu brut du fichier .lic glisse-depose, OU code colle par
  // l'utilisateur (meme JSON, eventuellement encode en base64 - voir
  // parseLicenceFileContent).
  content: z.string().min(1, "Aucun contenu de licence fourni."),
});

licenceRouter.post("/api/licence/activate", async (req, res) => {
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Fichier ou code de licence manquant." });
    return;
  }

  try {
    const status = await activateLicence(parsed.data.content);
    res.status(201).json(status);
  } catch (error) {
    if (error instanceof LicenceError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error("[licence] erreur inattendue lors de l'activation", error);
    res.status(500).json({ error: "Erreur interne lors de l'activation de la licence." });
  }
});

// Bouton "Verifier maintenant" - seul declencheur reseau autorise en mode
// manuel (voir runPhoneHomeCheck({ force: true }) et README-LOT3.md).
licenceRouter.post("/api/licence/check-now", async (_req, res) => {
  const result = await runPhoneHomeCheck({ force: true });
  const status = await getCurrentLicenceStatus();
  res.json({ result, status });
});
