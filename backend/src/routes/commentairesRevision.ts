import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { logAuditStep } from "../services/audit";
import { sendEmail } from "../services/mailer";
import { resolveCabinetEmailIdentite } from "../services/cabinetContact";
import { creerNotificationsMultiples } from "../services/notifications";

export const commentairesRevisionRouter = Router();

// Statuts d'Action sur lesquels une remarque peut etre laissee : le document
// est en attente d'un avis (en_attente_validation), ou deja en revision
// (une remarque supplementaire, avant que le collaborateur ait renvoye pour
// validation). Voir README-LOT10.md.
const STATUTS_COMMENTABLES = new Set(["en_attente_validation", "revision_demandee"]);

const commentaireSchema = z.object({
  contenu: z.string().trim().min(1, "La remarque ne peut pas être vide.").max(5000),
  // Un ou plusieurs collaborateurs/avocats precis a qui adresser CETTE
  // remarque (demande utilisateur du 2026-10-14) - absent/vide = comportement
  // historique (adressee a l'auteur du document, Action.createdBy).
  destinataireIds: z.array(z.string().uuid()).max(20).optional(),
});

async function findActionDuCabinet(actionId: string, cabinetId: string) {
  return prisma.action.findFirst({
    where: { id: actionId, dossier: { cabinetId } },
  });
}

// Cree une remarque de revision - reserve aux avocats/titulaire (jamais un
// collaborateur, meme sur ses propres documents). Fait automatiquement
// passer le document en "revision_demandee" s'il ne l'est pas deja.
commentairesRevisionRouter.post(
  "/api/actions/:id/commentaires",
  requireAuth,
  requireModule("revision"),
  async (req, res) => {
    if (req.auth!.role === "collaborateur") {
      return res.status(403).json({ error: "Seul un avocat du cabinet peut laisser une remarque de révision." });
    }

    const parsed = commentaireSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Remarque invalide" });
    }

    const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
    if (!action) {
      return res.status(404).json({ error: "Action introuvable" });
    }
    if (!STATUTS_COMMENTABLES.has(action.statut)) {
      return res.status(409).json({
        error: "Les remarques ne sont possibles que sur un document en attente de validation ou déjà en révision.",
      });
    }

    // Valide que chaque destinataire propose appartient bien a ce cabinet et
    // est actif - jamais de confiance aveugle dans des id transmis par le
    // client (demande utilisateur du 2026-10-14 : un ou plusieurs
    // destinataires precis, plutot que toujours l'auteur du document).
    let destinatairesValides: { id: string }[] = [];
    if (parsed.data.destinataireIds && parsed.data.destinataireIds.length > 0) {
      destinatairesValides = await prisma.user.findMany({
        where: { id: { in: parsed.data.destinataireIds }, cabinetId: req.auth!.cabinetId, actif: true },
        select: { id: true },
      });
    }

    const commentaire = await prisma.commentaireRevision.create({
      data: {
        actionId: action.id,
        auteurId: req.auth!.userId,
        contenu: parsed.data.contenu,
        destinataires: { create: destinatairesValides.map((d) => ({ userId: d.id })) },
      },
      include: {
        auteur: { select: { nom: true } },
        resoluPar: { select: { nom: true } },
        destinataires: { include: { user: { select: { id: true, nom: true } } } },
      },
    });

    if (action.statut !== "revision_demandee") {
      await prisma.action.update({ where: { id: action.id }, data: { statut: "revision_demandee" } });
    }

    await logAuditStep(
      action.id,
      "remarque_revision",
      "succes",
      `Remarque ajoutée par ${req.auth!.userId} : ${parsed.data.contenu.slice(0, 200)}`
    );

    // Destinataires de la notification : ceux explicitement designes,
    // sinon comportement historique (l'auteur du document) - jamais a
    // soi-meme (cas rare mais possible : un avocat se corrigeant sur son
    // propre document, ou se designant lui-meme par erreur).
    const ciblesIds = (destinatairesValides.length > 0 ? destinatairesValides.map((d) => d.id) : [action.createdBy]).filter(
      (id) => id !== req.auth!.userId
    );

    if (ciblesIds.length > 0) {
      const cibles = await prisma.user.findMany({
        where: { id: { in: ciblesIds }, actif: true },
        select: { id: true, email: true },
      });
      if (cibles.length > 0) {
        const { cabinetNom, replyToEmail } = await resolveCabinetEmailIdentite(req.auth!.cabinetId);
        for (const cible of cibles) {
          // Un email par destinataire - jamais bloquant pour les autres si
          // l'un d'eux echoue (adresse invalide, etc.).
          const mailResult = await sendEmail({
            destinataireEmail: cible.email,
            cabinetNom,
            replyToEmail,
            subject: `${cabinetNom} - Révision demandée sur "${action.nomDocument || action.typeAction}"`,
            text: `${commentaire.auteur.nom} a demandé une révision sur le document "${action.nomDocument || action.typeAction}".\n\nRemarque : ${parsed.data.contenu}\n\nConnecte-toi à Aurore pour y répondre.`,
          });
          if (!mailResult.ok) {
            console.error(`[commentaires-revision] échec de l'envoi de la notification de révision à ${cible.email} :`, mailResult.error);
          }
        }
      }

      await creerNotificationsMultiples(ciblesIds, {
        cabinetId: req.auth!.cabinetId,
        type: "revision_demandee",
        titre: `Révision demandée sur "${action.nomDocument || action.typeAction}"`,
        message: parsed.data.contenu,
        lienUrl: `/dossier.html?id=${action.dossierId}`,
        creeParId: req.auth!.userId,
      });
    }

    return res.status(201).json(commentaire);
  }
);

// Notification in-app (popup, voir public/js/layout.js) : documents dont
// CET utilisateur precis est l'auteur et qui viennent d'etre renvoyes en
// revision - jamais les revisions demandees sur le travail de quelqu'un
// d'autre, meme visible dans le meme cabinet.
commentairesRevisionRouter.get(
  "/api/actions/mes-revisions-demandees",
  requireAuth,
  requireModule("revision"),
  async (req, res) => {
    const actions = await prisma.action.findMany({
      where: {
        createdBy: req.auth!.userId,
        statut: "revision_demandee",
        dossier: { cabinetId: req.auth!.cabinetId },
      },
      select: {
        id: true,
        nomDocument: true,
        typeAction: true,
        dossierId: true,
        dossier: { select: { numeroDossier: true, nomAffaire: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return res.json(actions);
  }
);

commentairesRevisionRouter.get(
  "/api/actions/:id/commentaires",
  requireAuth,
  requireModule("revision"),
  async (req, res) => {
    const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
    if (!action) {
      return res.status(404).json({ error: "Action introuvable" });
    }

    const commentaires = await prisma.commentaireRevision.findMany({
      where: { actionId: action.id },
      orderBy: { dateCreation: "asc" },
      include: {
        auteur: { select: { nom: true } },
        resoluPar: { select: { nom: true } },
        destinataires: { include: { user: { select: { id: true, nom: true } } } },
      },
    });

    return res.json(commentaires);
  }
);

// Transition explicite revision_demandee -> en_attente_validation. Les
// remarques ne bloquent plus ce renvoi (demande utilisateur du 2026-10-14 :
// des qu'une remarque est faite, les personnes concernees doivent pouvoir
// intervenir sur le document sans etape de "marquage resolu" manuelle) -
// elles sont toutes marquees resolues automatiquement au moment du renvoi,
// pour garder un historique clair de qui a cloture quoi et quand.
const renvoyerValidationSchema = z.object({
  note: z.string().trim().max(2000).optional(),
});

commentairesRevisionRouter.post(
  "/api/actions/:id/renvoyer-validation",
  requireAuth,
  requireModule("revision"),
  async (req, res) => {
    const parsed = renvoyerValidationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
    }

    const action = await findActionDuCabinet(req.params.id, req.auth!.cabinetId);
    if (!action) {
      return res.status(404).json({ error: "Action introuvable" });
    }
    if (action.statut !== "revision_demandee") {
      return res.status(409).json({ error: "Ce document n'est pas en révision." });
    }

    await prisma.commentaireRevision.updateMany({
      where: { actionId: action.id, statut: "ouvert" },
      data: { statut: "resolu", dateResolution: new Date(), resoluParId: req.auth!.userId },
    });
    await prisma.action.update({ where: { id: action.id }, data: { statut: "en_attente_validation" } });
    await logAuditStep(
      action.id,
      "renvoi_validation",
      "succes",
      `Renvoyé pour validation par ${req.auth!.userId}${parsed.data.note ? ` - Note : ${parsed.data.note}` : ""}`
    );

    // Notifie chaque avocat ayant laisse au moins une remarque sur cette
    // action (plusieurs lignes distinctes possibles dans CommentaireRevision
    // - naturellement multi-destinataires si plusieurs avocats sont
    // intervenus, sans changement de schema).
    const auteurs = await prisma.commentaireRevision.findMany({
      where: { actionId: action.id },
      distinct: ["auteurId"],
      select: { auteurId: true },
    });
    const heure = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    await creerNotificationsMultiples(
      auteurs.map((a) => a.auteurId),
      {
        cabinetId: req.auth!.cabinetId,
        type: "revision_terminee",
        titre: `Révision terminée sur "${action.nomDocument || action.typeAction}" à ${heure}`,
        message: parsed.data.note,
        lienUrl: `/dossier.html?id=${action.dossierId}`,
        creeParId: req.auth!.userId,
      }
    );

    return res.json({ ok: true });
  }
);
