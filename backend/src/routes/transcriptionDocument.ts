import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { findOrCreateDossier } from "./webActions";

export const transcriptionDocumentRouter = Router();

/**
 * Point d'entree "Transcrire un document" de Nouvelle action (3e mode, a
 * cote de "Generer avec l'IA" et "Rediger librement") - resout/cree le
 * dossier cible (meme logique que redaction-libre, findOrCreateDossier),
 * SANS jamais creer d'Action : le frontend enchaine ensuite avec l'upload
 * classique (POST /api/dossiers/:dossierId/documents, routes/documentsDossier.ts),
 * qui declenche l'OCR automatiquement (Lot 17) - aucune nouvelle logique de
 * stockage/OCR ici, uniquement la resolution du dossier.
 */
const schema = z.object({
  numero_dossier: z.string().trim().optional(),
  nom_affaire: z.string().trim().optional(),
  nom_client: z.string().trim().min(1, "Le nom du client est requis."),
});

transcriptionDocumentRouter.post(
  "/api/transcription/dossier",
  requireAuth,
  requireModule("nouvelle_action"),
  async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
    }

    const dossierResult = await findOrCreateDossier({
      cabinetId: req.auth!.cabinetId,
      userId: req.auth!.userId,
      numeroDossier: parsed.data.numero_dossier,
      nomAffaire: parsed.data.nom_affaire,
      nomClient: parsed.data.nom_client,
    });
    if (!dossierResult.ok) {
      return res.status(400).json({ error: dossierResult.error });
    }

    return res.status(200).json({ dossierId: dossierResult.dossier.id });
  }
);
