import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { logAuditStep } from "../services/audit";
import { resolveCabinetEmailIdentite } from "../services/cabinetContact";
import { sendDocumentEmail } from "../services/mailer";
import { buildPdf } from "../services/documentExport";
import { loadExportInput, resolveSignature, resolveEntete } from "./documentExport";
import { TYPE_LABELS, slugify } from "../utils/documentNaming";

export const actionsCallbackRouter = Router();

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
  // Envoi direct du PDF genere localement (formalisme complet - voir
  // documentFormalisme.ts) par email via Brevo/Nodemailer.
  const loaded = await loadExportInput(action.id, req.auth!.cabinetId);
  if (!loaded) {
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

  const signatureResolution = await resolveSignature(
    req.auth!.userId,
    parsed.data.avecSignature,
    parsed.data.positionSignature
  );
  if (!signatureResolution.ok) {
    return res.status(403).json({ error: signatureResolution.error });
  }
  const entete = await resolveEntete(req.auth!.cabinetId, true);

  const pdfBuffer = await buildPdf({
    ...loaded.input,
    signature: signatureResolution.signature,
    entete,
  });
  const filename = `${slugify(action.nomDocument || `${TYPE_LABELS[action.typeAction] || action.typeAction}-${action.dossier.numeroDossier}`)}.pdf`;

  const { cabinetNom, replyToEmail } = await resolveCabinetEmailIdentite(req.auth!.cabinetId);

  const mailResult = await sendDocumentEmail({
    destinataireEmail: parsed.data.email,
    cabinetNom,
    replyToEmail,
    nomAffaire: action.dossier.nomAffaire,
    attachment: { filename, content: pdfBuffer, contentType: "application/pdf" },
  });

  await logAuditStep(
    action.id,
    "envoi_email",
    mailResult.ok ? "succes" : "erreur",
    mailResult.ok ? parsed.data.email : mailResult.error
  );

  if (!mailResult.ok) {
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

  // Lot 10 : un document ne peut pas etre valide tant qu'il reste des
  // remarques de revision ouvertes dessus - repasse forcement par le cycle
  // revision_demandee -> renvoyer-validation (toutes remarques resolues)
  // avant toute nouvelle tentative de validation.
  const commentairesOuverts = await prisma.commentaireRevision.count({
    where: { actionId: action.id, statut: "ouvert" },
  });
  if (commentairesOuverts > 0) {
    return res.status(409).json({
      error: `Ce document a ${commentairesOuverts} remarque(s) de révision non résolue(s) : il ne peut pas être validé tant qu'elles restent ouvertes.`,
    });
  }

  await prisma.action.update({ where: { id: action.id }, data: { statut: "valide" } });
  return res.json({ ok: true });
});

const updateContenuSchema = z.object({
  contenu: z.string().min(1),
});

// Correction du texte genere directement dans Aurore - alimente ensuite les
// exports Word/PDF ET, une fois ce circuit devenu la source de verite pour
// l'envoi, l'email envoye au client. Autorise a quiconque peut
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
