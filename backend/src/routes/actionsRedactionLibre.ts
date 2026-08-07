import { Router } from "express";
import { z } from "zod";
import { TypeAction } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { logAuditStep } from "../services/audit";
import { gabaritPour } from "../services/gabaritsRedactionLibre";
import { findOrCreateDossier } from "./webActions";
import { computeNomDocument } from "../utils/documentNaming";

export const actionsRedactionLibreRouter = Router();

// Validation minimale, volontairement separee du schema Zod du mode IA
// (webForms.ts, jamais touche par ce lot) : type de document valide parmi
// les 16 existants + dossier/client, aucun champ metier obligatoire.
const redactionLibreSchema = z.object({
  type_action: z.nativeEnum(TypeAction),
  numero_dossier: z.string().trim().optional(),
  nom_affaire: z.string().trim().optional(),
  nom_client: z.string().trim().min(1, "Le nom du client est requis."),
});

// Chemin de creation alternatif complet au mode "generation IA"
// (POST /api/actions/web, webActions.ts) - jamais d'appel LLM, jamais de
// pseudonymisation, champsDocument reste vide. Memes permissions de
// creation que le mode IA (requireModule("nouvelle_action"), memes roles
// autorises a creer une Action sur un dossier).
actionsRedactionLibreRouter.post(
  "/api/actions/redaction-libre",
  requireAuth,
  requireModule("nouvelle_action"),
  async (req, res) => {
    const parsed = redactionLibreSchema.safeParse(req.body);
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
    const dossier = dossierResult.dossier;

    const contenuGenere = gabaritPour(parsed.data.type_action);
    const nomDocument = computeNomDocument({
      typeAction: parsed.data.type_action,
      nomClient: parsed.data.nom_client,
      numeroDossier: dossier.numeroDossier,
    });

    const action = await prisma.action.create({
      data: {
        dossierId: dossier.id,
        typeAction: parsed.data.type_action,
        canal: "web",
        contenuGenere,
        statut: "en_attente_validation",
        modeCreation: "redaction_libre",
        nomDocument,
        createdBy: req.auth!.userId,
      },
    });

    // Tracabilite homogene avec une creation en mode IA (webActions.ts) -
    // meme mecanisme AuditLog, meme si aucun appel LLM n'a eu lieu ici.
    await logAuditStep(action.id, "creation_redaction_libre", "succes", `Créé par ${req.auth!.userId}`);

    return res.status(201).json({ actionId: action.id, dossierId: dossier.id, contenuGenere });
  }
);
