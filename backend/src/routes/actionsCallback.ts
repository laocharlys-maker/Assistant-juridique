import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { env } from "../config/env";
import { callN8nWebhook } from "../services/n8n";
import { logAuditStep } from "../services/audit";
import { resolveCabinetEmailIdentite } from "../services/cabinetContact";

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
  positionSignature: z.enum(["START", "CENTER", "END"]).optional().default("END"),
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

  // Un collaborateur ne peut jamais envoyer un document directement a un
  // client : uniquement a un membre du cabinet (son avocat responsable, un
  // autre avocat, ou lui-meme), pour relecture/envoi par un avocat.
  if (req.auth!.role === "collaborateur") {
    const destinataireEstDuCabinet = await prisma.user.findFirst({
      where: { email: parsed.data.email, cabinetId: req.auth!.cabinetId },
    });
    if (!destinataireEstDuCabinet) {
      return res.status(403).json({
        error: "Tu ne peux envoyer ce document qu'à un membre du cabinet, pas directement à un client.",
      });
    }
  }
  if (!action.documentUrl || !action.documentId) {
    return res.status(409).json({ error: "Le document n'est pas encore prêt" });
  }
  // Les recherches (jurisprudence / recherche juridique) n'ont pas
  // d'etape de validation manuelle : des qu'elles sont pretes, elles
  // peuvent etre envoyees directement.
  const validationRequise = !action.dossier.estRecherche;
  if (validationRequise && action.statut !== "valide") {
    return res
      .status(409)
      .json({ error: "L'action doit être validée avant de pouvoir être envoyée" });
  }
  if (!validationRequise && action.statut !== "valide" && action.statut !== "en_attente_validation") {
    return res.status(409).json({ error: "Le document n'est pas encore prêt" });
  }

  let signatureUrl: string | null = null;
  if (parsed.data.avecSignature) {
    const currentUser = await prisma.user.findUnique({
      where: { id: req.auth!.userId },
      include: { responsable: true },
    });

    let signaturePath: string | null = null;
    if (currentUser?.role === "collaborateur") {
      // Un collaborateur n'insere jamais sa propre signature via ce
      // mecanisme : uniquement celle de son responsable, et seulement si
      // celui-ci l'y a explicitement autorise.
      if (currentUser.partageSignatureActif && currentUser.responsable?.signatureUrl) {
        signaturePath = currentUser.responsable.signatureUrl;
      } else {
        return res.status(403).json({
          error: "Ton avocat responsable ne t'a pas autorisé à insérer sa signature",
        });
      }
    } else {
      signaturePath = currentUser?.signatureUrl ?? null;
    }

    signatureUrl =
      signaturePath && env.PUBLIC_BASE_URL
        ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${signaturePath}`
        : null;
  }

  const { cabinetNom, replyToEmail } = await resolveCabinetEmailIdentite(req.auth!.cabinetId);

  const n8nResult = await callN8nWebhook("envoyer-email", {
    actionId: action.id,
    documentId: action.documentId,
    destinataireEmail: parsed.data.email,
    nomAffaire: action.dossier.nomAffaire,
    signatureUrl,
    signatureAlignment: parsed.data.positionSignature,
    cabinetNom,
    replyToEmail,
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
  // Seul un avocat (ou le titulaire) peut valider un document - jamais un
  // collaborateur, meme sur ses propres documents.
  if (req.auth!.role === "collaborateur") {
    return res.status(403).json({ error: "Seul un avocat du cabinet peut valider un document." });
  }

  const action = await prisma.action.findFirst({
    where: { id: req.params.id, dossier: { cabinetId: req.auth!.cabinetId } },
  });
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }

  await prisma.action.update({ where: { id: action.id }, data: { statut: "valide" } });
  return res.json({ ok: true });
});

const updateContenuSchema = z.object({
  contenu: z.string().min(1),
});

// Correction du texte genere directement dans Aurore (alternative au lien
// "Ouvrir / modifier le document" qui pointe vers Google Docs) - alimente
// ensuite les exports Word/PDF ET, une fois ce circuit devenu la source de
// verite pour l'envoi, l'email envoye au client. Autorise a quiconque peut
// deja generer des documents (y compris un collaborateur sur ses propres
// brouillons) - seule la validation reste reservee aux avocats/titulaire.
actionsCallbackRouter.patch("/api/actions/:id/contenu", requireAuth, async (req, res) => {
  const parsed = updateContenuSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Contenu invalide" });
  }

  const action = await prisma.action.findFirst({
    where: { id: req.params.id, dossier: { cabinetId: req.auth!.cabinetId } },
  });
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }
  if (action.statut === "envoye") {
    return res.status(409).json({ error: "Ce document a déjà été envoyé, son contenu ne peut plus être modifié." });
  }

  const updated = await prisma.action.update({
    where: { id: action.id },
    data: { contenuGenere: parsed.data.contenu },
  });
  return res.json({ contenuGenere: updated.contenuGenere });
});
