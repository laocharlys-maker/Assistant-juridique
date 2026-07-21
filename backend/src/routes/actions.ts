import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { getLlmProvider, LlmOutputError } from "../services/llm";
import { validateExtraction, buildClarificationMessage } from "../services/validation";
import { callN8nWebhook, webhookForAction } from "../services/n8n";
import { logAuditStep } from "../services/audit";

export const actionsRouter = Router();

const whatsappRequestSchema = z.object({
  cabinetId: z.string().uuid(),
  userId: z.string().uuid(),
  rawText: z.string().min(1),
});

actionsRouter.post("/api/actions/whatsapp", async (req, res) => {
  const parsedRequest = whatsappRequestSchema.safeParse(req.body);
  if (!parsedRequest.success) {
    return res.status(400).json({ error: "Requete invalide", details: parsedRequest.error.issues });
  }
  const { cabinetId, userId, rawText } = parsedRequest.data;

  try {
    let extracted;
    try {
      extracted = await getLlmProvider().extractAction(rawText);
    } catch (error) {
      console.error("Erreur appel LLM sur /api/actions/whatsapp :", error);
      const message = error instanceof LlmOutputError ? error.message : "Erreur IA inattendue";
      await callN8nWebhook("whatsapp-reply", {
        userId,
        message: `Désolée, je n'ai pas pu traiter ce message (${message}). Peux-tu reformuler ?`,
      });
      return res.status(502).json({ error: message });
    }

    const validation = validateExtraction(extracted);
    if (!validation.valid) {
      await callN8nWebhook("whatsapp-reply", {
        userId,
        message: buildClarificationMessage(validation),
      });
      return res
        .status(422)
        .json({ error: "Champs manquants", missingFields: validation.missingFields });
    }

    const dossier = await prisma.dossier.upsert({
      where: {
        cabinetId_numeroDossier: {
          cabinetId,
          numeroDossier: extracted.numero_dossier ?? "SANS-NUMERO",
        },
      },
      update: {
        nomAffaire: extracted.nom_affaire ?? undefined,
        nomClient: extracted.nom_client ?? undefined,
        nomJuge: extracted.nom_juge ?? undefined,
      },
      create: {
        cabinetId,
        numeroDossier: extracted.numero_dossier ?? "SANS-NUMERO",
        nomAffaire: extracted.nom_affaire ?? "Affaire sans nom",
        nomClient: extracted.nom_client ?? "Non précisé",
        nomJuge: extracted.nom_juge,
        createdBy: userId,
      },
    });

    const action = await prisma.action.create({
      data: {
        dossierId: dossier.id,
        typeAction: extracted.type_action,
        canal: "whatsapp",
        contenuGenere: extracted.synthese ?? extracted.argumentaire,
        dateAudience: extracted.date_audience ? new Date(extracted.date_audience) : null,
        prochaineAudience: extracted.prochaine_audience
          ? new Date(extracted.prochaine_audience)
          : null,
        piecesPrevoir: extracted.pieces_prevoir,
        createdBy: userId,
      },
    });

    await logAuditStep(action.id, "extraction_ia", "succes", extracted.categorie_texte);

    const n8nResult = await callN8nWebhook(webhookForAction(extracted.type_action), {
      ...extracted,
      dossierId: dossier.id,
      actionId: action.id,
    });

    await logAuditStep(
      action.id,
      "declenchement_n8n",
      n8nResult.ok ? "succes" : "erreur",
      n8nResult.error
    );

    if (!n8nResult.ok) {
      await callN8nWebhook("whatsapp-reply", {
        userId,
        message:
          "Le document est en cours de traitement, mais un souci technique est survenu. L'équipe est prévenue.",
      });
    }

    return res
      .status(201)
      .json({ dossierId: dossier.id, actionId: action.id, n8nDispatched: n8nResult.ok });
  } catch (error) {
    console.error("Erreur inattendue sur /api/actions/whatsapp", error);
    await callN8nWebhook("whatsapp-reply", {
      userId,
      message: "Une erreur technique est survenue. L'équipe a été prévenue, merci de réessayer plus tard.",
    });
    return res.status(500).json({ error: "Erreur interne" });
  }
});
