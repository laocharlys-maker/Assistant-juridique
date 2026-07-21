import { Router } from "express";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { getLlmProvider } from "../services/llm";
import { callN8nWebhook, webhookForAction } from "../services/n8n";
import { logAuditStep } from "../services/audit";
import { webActionFormSchema } from "../schemas/webForms";
import {
  NOTES_SYSTEM_PROMPT,
  REDAC_SYSTEM_PROMPT,
  JURISPRUDENCE_SYSTEM_PROMPT,
  buildNotesUserPrompt,
  buildRedacUserPrompt,
  buildJurisprudenceUserPrompt,
} from "../prompts/webRedaction";
import { ActionOutput } from "../schemas/action";

export const webActionsRouter = Router();

webActionsRouter.post("/api/actions/web", requireAuth, async (req, res) => {
  const parsed = webActionFormSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const form = parsed.data;
  const { auth } = req;
  const llm = getLlmProvider();

  try {
    let dossierId: string;
    let action: ActionOutput;

    if (form.type_action === "notes") {
      const redigé = await llm.redact(
        NOTES_SYSTEM_PROMPT,
        buildNotesUserPrompt({
          numeroDossier: form.numero_dossier,
          nomAffaire: form.nom_affaire,
          nomClient: form.nom_client,
          nomJuge: form.nom_juge,
          decision: form.decision,
          prochaineAudience: form.prochaine_audience,
          piecesPrevoir: form.pieces_prevoir,
        })
      );

      const dossier = await prisma.dossier.upsert({
        where: {
          cabinetId_numeroDossier: { cabinetId: auth!.cabinetId, numeroDossier: form.numero_dossier },
        },
        update: {
          nomAffaire: form.nom_affaire,
          nomClient: form.nom_client,
          nomJuge: form.nom_juge,
        },
        create: {
          cabinetId: auth!.cabinetId,
          numeroDossier: form.numero_dossier,
          nomAffaire: form.nom_affaire,
          nomClient: form.nom_client,
          nomJuge: form.nom_juge,
          createdBy: auth!.userId,
        },
      });
      dossierId = dossier.id;

      action = {
        type_action: "notes",
        categorie_texte: "Compte-rendu d'audience",
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
        nom_client: form.nom_client,
        nom_juge: form.nom_juge ?? null,
        date_audience: new Date().toISOString().slice(0, 10),
        decision: form.decision,
        prochaine_audience: form.prochaine_audience ?? null,
        pieces_prevoir: form.pieces_prevoir?.join(", ") ?? null,
        synthese: redigé,
        argumentaire: null,
      };
    } else if (form.type_action === "redac") {
      const redigé = await llm.redact(
        REDAC_SYSTEM_PROMPT,
        buildRedacUserPrompt({
          nomAffaire: form.nom_affaire,
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
        })
      );

      const dossier = await prisma.dossier.findFirst({
        where: { cabinetId: auth!.cabinetId, numeroDossier: form.numero_dossier },
      });
      if (!dossier) {
        return res.status(404).json({ error: "Dossier introuvable pour ce numéro" });
      }
      dossierId = dossier.id;

      action = {
        type_action: "redac",
        categorie_texte: "Plaidoirie",
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
        nom_client: null,
        nom_juge: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else {
      const redigé = await llm.redact(
        JURISPRUDENCE_SYSTEM_PROMPT,
        buildJurisprudenceUserPrompt({ theme: form.theme, juridictions: form.juridictions ?? [] })
      );

      // Recherche de jurisprudence : pas forcement liee a un dossier existant.
      const dossier = await prisma.dossier.upsert({
        where: {
          cabinetId_numeroDossier: { cabinetId: auth!.cabinetId, numeroDossier: `JURIS-${Date.now()}` },
        },
        update: {},
        create: {
          cabinetId: auth!.cabinetId,
          numeroDossier: `JURIS-${Date.now()}`,
          nomAffaire: form.theme,
          nomClient: "Non applicable",
          createdBy: auth!.userId,
        },
      });
      dossierId = dossier.id;

      action = {
        type_action: "jurisprudence",
        categorie_texte: "Recherche de jurisprudence",
        numero_dossier: null,
        nom_affaire: form.theme,
        nom_client: null,
        nom_juge: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    }

    const savedAction = await prisma.action.create({
      data: {
        dossierId,
        typeAction: action.type_action,
        canal: "web",
        contenuGenere: action.synthese ?? action.argumentaire,
        dateAudience: action.date_audience ? new Date(action.date_audience) : null,
        prochaineAudience: action.prochaine_audience ? new Date(action.prochaine_audience) : null,
        piecesPrevoir: action.pieces_prevoir,
        createdBy: auth!.userId,
      },
    });

    await logAuditStep(savedAction.id, "redaction_ia", "succes", action.categorie_texte);

    const n8nResult = await callN8nWebhook(webhookForAction(action.type_action), {
      ...action,
      dossierId,
      actionId: savedAction.id,
    });

    await logAuditStep(
      savedAction.id,
      "declenchement_n8n",
      n8nResult.ok ? "succes" : "erreur",
      n8nResult.error
    );

    return res.status(201).json({
      dossierId,
      actionId: savedAction.id,
      contenu: action.synthese ?? action.argumentaire,
      n8nDispatched: n8nResult.ok,
    });
  } catch (error) {
    console.error("Erreur inattendue sur /api/actions/web", error);
    return res.status(500).json({ error: "Erreur interne" });
  }
});
