import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { env } from "../config/env";
import { callN8nWebhook } from "../services/n8n";
import { logAuditStep } from "../services/audit";

export const actionsCallbackRouter = Router();

const callbackSchema = z.object({
  actionId: z.string().uuid(),
  documentUrl: z.string().url(),
  documentId: z.string().min(1),
});

// Appele par n8n une fois le document Google Docs genere. Pas d'authentification
// utilisateur (c'est n8n qui appelle), mais verification d'un secret partage.
actionsCallbackRouter.post("/api/actions/document-callback", async (req, res) => {
  if (env.N8N_WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== env.N8N_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Secret invalide" });
  }

  const parsed = callbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }
  const { actionId, documentUrl, documentId } = parsed.data;

  const action = await prisma.action.findUnique({ where: { id: actionId } });
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }

  await prisma.action.update({
    where: { id: actionId },
    data: { documentUrl, documentId, statut: "en_attente_validation" },
  });

  await logAuditStep(actionId, "document_pret", "succes", documentUrl);

  return res.json({ ok: true });
});

const envoyerSchema = z.object({
  email: z.string().email(),
  avecSignature: z.boolean().optional().default(false),
});

actionsCallbackRouter.post("/api/actions/:id/envoyer", requireAuth, async (req, res) => {
  const parsed = envoyerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Email invalide" });
  }

  const action = await prisma.action.findFirst({
    where: { id: req.params.id, dossier: { cabinetId: req.auth!.cabinetId } },
    include: { dossier: true },
  });
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }
  if (!action.documentUrl || !action.documentId) {
    return res.status(409).json({ error: "Le document n'est pas encore prêt" });
  }
  if (action.statut !== "valide") {
    return res
      .status(409)
      .json({ error: "L'action doit être validée avant de pouvoir être envoyée" });
  }

  let signatureUrl: string | null = null;
  if (parsed.data.avecSignature) {
    const currentUser = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
    signatureUrl =
      currentUser?.signatureUrl && env.PUBLIC_BASE_URL
        ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${currentUser.signatureUrl}`
        : null;
  }

  const n8nResult = await callN8nWebhook("envoyer-email", {
    actionId: action.id,
    documentId: action.documentId,
    destinataireEmail: parsed.data.email,
    nomAffaire: action.dossier.nomAffaire,
    signatureUrl,
  });

  await logAuditStep(
    action.id,
    "envoi_email",
    n8nResult.ok ? "succes" : "erreur",
    n8nResult.ok ? parsed.data.email : n8nResult.error
  );

  if (!n8nResult.ok) {
    return res.status(502).json({ error: "Échec de l'envoi, réessaie dans un instant" });
  }

  await prisma.action.update({
    where: { id: action.id },
    data: { statut: "envoye", destinataireEmail: parsed.data.email, envoyeAt: new Date() },
  });

  return res.json({ ok: true });
});

actionsCallbackRouter.post("/api/actions/:id/valider", requireAuth, async (req, res) => {
  const action = await prisma.action.findFirst({
    where: { id: req.params.id, dossier: { cabinetId: req.auth!.cabinetId } },
  });
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }

  await prisma.action.update({ where: { id: action.id }, data: { statut: "valide" } });
  return res.json({ ok: true });
});
