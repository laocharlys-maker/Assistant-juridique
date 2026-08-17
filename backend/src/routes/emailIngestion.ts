import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { isMissingConfigurationError } from "../lib/configurationError";
import {
  buildGmailAuthUrl,
  exchangeCodeForTokens,
  telechargerPieceJointe as telechargerPieceJointeGmail,
  obtenirContenuComplet as obtenirContenuCompletGmail,
  envoyerReponse as envoyerReponseGmail,
} from "../services/emailIngestion/gmailClient";
import {
  testerConnexion as testerConnexionImap,
  telechargerPieceJointe as telechargerPieceJointeImap,
  obtenirContenuComplet as obtenirContenuCompletImap,
  envoyerReponse as envoyerReponseImap,
} from "../services/emailIngestion/imapClient";
import { suggererDossiers } from "../services/emailIngestion/suggestionDossier";
import { verifierConnexionMaintenant } from "../services/emailIngestion/polling";
import { enregistrerFichier } from "../services/stockageDocuments";
import { enqueuerSyncEvenement } from "../services/calendrierSync/syncQueue";
import type { PieceJointeDetectee } from "../services/emailIngestion/types";

export const emailIngestionRouter = Router();

/**
 * Lot 16 - ingestion email assistee. Regle centrale, jamais d'exception :
 * connecter une boite mail et le polling (services/emailIngestion/polling.ts)
 * n'ecrivent QUE des lignes EmailImporte (metadonnees). Un DocumentDossier ou
 * un Evenement n'est cree QUE par les deux routes de confirmation explicite
 * ci-dessous (POST .../importer-piece, POST .../confirmer-evenement) -
 * jamais automatiquement (voir README-LOT16.md).
 */

// Etat OAuth ephemere (protection CSRF) - meme pattern que
// routes/calendrierExterne.ts (Lot 12b) : en memoire, duree de vie courte,
// un seul process backend.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map<string, { userId: string; expiresAt: number }>();

function purgerEtatsExpires(): void {
  const maintenant = Date.now();
  for (const [state, info] of oauthStates) {
    if (info.expiresAt < maintenant) oauthStates.delete(state);
  }
}

// Meme regle d'acces qu'un dossier via sa fiche (GET /api/dossiers/:id) :
// tout membre du cabinet peut importer une piece / creer un evenement sur un
// dossier de son cabinet - pas de nouveau systeme de droits (voir
// documentsDossier.ts, Lot 15).
async function chargerDossierAccessible(dossierId: string, cabinetId: string) {
  return prisma.dossier.findFirst({ where: { id: dossierId, cabinetId } });
}

// --- Statut des connexions (jamais les tokens/mots de passe) ---

// Sans try/catch, une erreur ici (Prisma, dechiffrement au repos - voir
// security/prismaEncryption.ts) resterait une promesse rejetee non
// rattrapee : le filet de securite de index.ts (process.on("unhandledRejection",
// ...)) arrete alors TOUT le backend, pas seulement cette requete - constate
// en usage reel sur d'autres routes de ce type (voir jurisprudenceBase.ts,
// meme raisonnement). D'ou ce try/catch explicite sur chaque route
// ci-dessous, meme celles qui semblaient jusqu'ici "sans risque".
emailIngestionRouter.get("/api/email-ingestion/statut", requireAuth, async (req, res) => {
  try {
    const connexions = await prisma.connexionEmailExterne.findMany({
      where: { userId: req.auth!.userId },
      select: {
        id: true,
        provider: true,
        actif: true,
        adresseEmail: true,
        imapHost: true,
        imapUsername: true,
        smtpHost: true,
        derniereErreur: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return res.json(connexions);
  } catch (error) {
    console.error("[email-ingestion] échec de lecture du statut des connexions :", error);
    return res.status(500).json({ error: "Impossible de charger le statut des boîtes mail connectées (voir logs serveur)" });
  }
});

// Declenchement manuel d'une synchronisation (bouton "Vérifier maintenant",
// voir parametres-email.js) - evite d'attendre jusqu'a 5 minutes le prochain
// cycle planifie (services/emailIngestion/polling.ts) pour voir si une
// connexion fonctionne, utile notamment pour diagnostiquer un probleme.
emailIngestionRouter.post("/api/email-ingestion/:id/verifier-maintenant", requireAuth, async (req, res) => {
  try {
    const connexion = await prisma.connexionEmailExterne.findFirst({
      where: { id: req.params.id, userId: req.auth!.userId },
    });
    if (!connexion) {
      return res.status(404).json({ error: "Connexion introuvable" });
    }

    await verifierConnexionMaintenant(connexion, req.auth!.cabinetId);

    const fraiche = await prisma.connexionEmailExterne.findUnique({
      where: { id: connexion.id },
      select: { derniereErreur: true },
    });
    return res.json({ ok: true, derniereErreur: fraiche?.derniereErreur ?? null });
  } catch (error) {
    console.error("[email-ingestion] échec de vérification manuelle :", error);
    return res.status(500).json({ error: "Impossible de vérifier cette boîte mail maintenant (voir logs serveur)" });
  }
});

// --- Connexion Gmail (OAuth2) ---

emailIngestionRouter.get("/api/email-ingestion/gmail/connecter", requireAuth, (req, res) => {
  purgerEtatsExpires();
  const state = crypto.randomUUID();
  oauthStates.set(state, { userId: req.auth!.userId, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
  try {
    return res.redirect(buildGmailAuthUrl(state));
  } catch (error) {
    if (isMissingConfigurationError(error)) {
      return res.status(503).json({ error: error.message });
    }
    throw error;
  }
});

// Pas de requireAuth : Google redirige un navigateur qui a pu perdre son
// cookie de session - l'identite est retrouvee via le `state` signe/stocke
// serveur (meme raisonnement que calendrierExterne.ts).
emailIngestionRouter.get("/api/email-ingestion/gmail/callback", async (req, res) => {
  purgerEtatsExpires();
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";

  const info = oauthStates.get(state);
  if (!info) {
    return res.status(400).send("Connexion Gmail expirée ou invalide — réessaie depuis Aurore (Paramètres > Boîte mail).");
  }
  oauthStates.delete(state);

  if (!code) {
    return res.redirect("/parametres-email.html?erreur=gmail_refuse");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await prisma.connexionEmailExterne.upsert({
      where: { userId_provider: { userId: info.userId, provider: "gmail" } },
      create: {
        userId: info.userId,
        provider: "gmail",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        actif: true,
      },
      update: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        actif: true,
        derniereErreur: null,
      },
    });
    return res.redirect("/parametres-email.html?connecte=gmail");
  } catch (error) {
    console.error("[email-ingestion] échec de connexion Gmail :", error instanceof Error ? error.message : error);
    return res.redirect("/parametres-email.html?erreur=gmail_echec");
  }
});

// --- Connexion IMAP generique ---

const imapSchema = z.object({
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().positive().default(993),
  imapSecure: z.boolean().default(true),
  imapUsername: z.string().min(1),
  imapPassword: z.string().min(1),
  // Facultatif : sans ces champs, la boîte reste utilisable en lecture,
  // seul le bouton "Répondre" (voir POST .../repondre plus bas) reste
  // absent tant qu'ils ne sont pas renseignés - voir services/emailIngestion/
  // imapClient.ts, identifiantsSmtpDe().
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().positive().optional(),
  smtpSecure: z.boolean().default(false),
});

emailIngestionRouter.post("/api/email-ingestion/imap", requireAuth, async (req, res) => {
  const parsed = imapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  try {
    await testerConnexionImap(parsed.data);
  } catch (error) {
    return res.status(502).json({
      error: `Impossible de se connecter à cette boîte IMAP : ${error instanceof Error ? error.message : "erreur inconnue"}.`,
    });
  }

  const connexion = await prisma.connexionEmailExterne.upsert({
    where: { userId_provider: { userId: req.auth!.userId, provider: "imap" } },
    create: { userId: req.auth!.userId, provider: "imap", ...parsed.data, actif: true },
    update: { ...parsed.data, actif: true, derniereErreur: null },
    select: { id: true, provider: true, actif: true, imapHost: true, imapUsername: true, smtpHost: true, createdAt: true },
  });

  return res.status(201).json(connexion);
});

// --- Deconnexion ---
// Supprime uniquement la connexion (tokens/identifiants) et, par cascade DB,
// les EmailImporte qui lui sont rattaches - JAMAIS les DocumentDossier deja
// importes (emailOrigineId passe simplement a null, onDelete: SetNull, voir
// schema.prisma) ni les Evenement deja crees (aucune relation vers
// EmailImporte) - critere d'acceptation explicite du prompt.
emailIngestionRouter.delete("/api/email-ingestion/:id", requireAuth, async (req, res) => {
  await prisma.connexionEmailExterne
    .deleteMany({ where: { id: req.params.id, userId: req.auth!.userId } })
    .catch(() => null);
  return res.json({ ok: true });
});

// --- Boîte de reception ---

function piecesJointesDe(valeur: unknown): PieceJointeDetectee[] {
  return Array.isArray(valeur) ? (valeur as PieceJointeDetectee[]) : [];
}

emailIngestionRouter.get("/api/email-ingestion/emails", requireAuth, async (req, res) => {
  try {
    const emails = await prisma.emailImporte.findMany({
      where: { connexion: { userId: req.auth!.userId } },
      orderBy: { dateReception: "desc" },
      take: 50,
    });

    const resultats = await Promise.all(
      emails.map(async (email) => ({
        id: email.id,
        expediteurEmail: email.expediteurEmail,
        expediteurNom: email.expediteurNom,
        objet: email.objet,
        dateReception: email.dateReception,
        piecesJointes: piecesJointesDe(email.piecesJointes),
        dateDetectee: email.dateDetectee,
        dateDetecteeContexte: email.dateDetecteeContexte,
        statut: email.statut,
        dossiersSuggeres: await suggererDossiers(prisma, req.auth!.cabinetId, email.expediteurEmail),
      }))
    );

    return res.json(resultats);
  } catch (error) {
    console.error("[email-ingestion] échec de chargement de la boîte de réception :", error);
    return res.status(500).json({ error: "Impossible de charger la boîte de réception (voir logs serveur)" });
  }
});

async function chargerEmailAccessible(id: string, userId: string) {
  return prisma.emailImporte.findFirst({
    where: { id, connexion: { userId } },
    include: { connexion: true },
  });
}

// Ignore explicitement l'email (aucune piece importee, aucun evenement
// cree) - marque simplement "traite" pour ne plus le re-representer.
emailIngestionRouter.post("/api/email-ingestion/emails/:id/ignorer", requireAuth, async (req, res) => {
  try {
    const email = await chargerEmailAccessible(req.params.id, req.auth!.userId);
    if (!email) {
      return res.status(404).json({ error: "Email introuvable" });
    }
    await prisma.emailImporte.update({ where: { id: email.id }, data: { statut: "traite" } });
    return res.json({ ok: true });
  } catch (error) {
    console.error("[email-ingestion] échec de mise à jour du statut (ignorer) :", error);
    return res.status(500).json({ error: "Impossible d'ignorer cet email (voir logs serveur)" });
  }
});

const importerPieceSchema = z.object({
  attachmentId: z.string().min(1),
  dossierId: z.string().uuid(),
});

// Import EXPLICITE d'une piece jointe vers un dossier choisi par
// l'utilisateur - reutilise directement stockageDocuments.ts (Lot 15), meme
// chiffrement au repos que pour un upload manuel.
emailIngestionRouter.post("/api/email-ingestion/emails/:id/importer-piece", requireAuth, async (req, res) => {
  try {
    const email = await chargerEmailAccessible(req.params.id, req.auth!.userId);
    if (!email) {
      return res.status(404).json({ error: "Email introuvable" });
    }

    const parsed = importerPieceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
    }

    const dossier = await chargerDossierAccessible(parsed.data.dossierId, req.auth!.cabinetId);
    if (!dossier) {
      return res.status(404).json({ error: "Dossier introuvable" });
    }

    const piece = piecesJointesDe(email.piecesJointes).find((p) => p.id === parsed.data.attachmentId);
    if (!piece) {
      return res.status(404).json({ error: "Pièce jointe introuvable sur cet email." });
    }

    let contenu: Buffer;
    try {
      contenu =
        email.connexion.provider === "gmail"
          ? await telechargerPieceJointeGmail(email.connexion, email.identifiantExterne, piece.id)
          : await telechargerPieceJointeImap(email.connexion, email.identifiantExterne, piece.id);
    } catch (error) {
      console.error(
        `[email-ingestion] échec de récupération de pièce jointe (email ${email.id}) :`,
        error instanceof Error ? error.message : error
      );
      return res.status(502).json({ error: "Impossible de récupérer cette pièce jointe depuis la boîte mail." });
    }

    const { nomFichier, tailleOctets } = await enregistrerFichier(dossier.id, contenu);

    const document = await prisma.documentDossier.create({
      data: {
        cabinetId: req.auth!.cabinetId,
        dossierId: dossier.id,
        nomOriginal: piece.nomFichier,
        typeMime: piece.typeMime,
        tailleOctets,
        nomFichier,
        source: "email",
        emailOrigineId: email.id,
        uploadeParId: req.auth!.userId,
      },
    });

    await prisma.emailImporte.update({ where: { id: email.id }, data: { statut: "traite" } });

    console.log(
      `[email-ingestion] import de pièce jointe : ${req.auth!.userId} -> document ${document.id} depuis l'email ${email.id} sur le dossier ${dossier.id}`
    );

    return res.status(201).json(document);
  } catch (error) {
    console.error("[email-ingestion] échec d'import de pièce jointe :", error);
    return res.status(500).json({ error: "Impossible d'importer cette pièce jointe (voir logs serveur)" });
  }
});

const TYPES_EVENEMENT_EMAIL = ["rdv", "appel", "tache", "autre"] as const;

const confirmerEvenementSchema = z.object({
  type: z.enum(TYPES_EVENEMENT_EMAIL).default("rdv"),
  titre: z.string().min(1),
  description: z.string().optional(),
  dateDebut: z.string().min(1),
  dateFin: z.string().optional(),
  touteLaJournee: z.boolean().optional().default(false),
  lieu: z.string().optional(),
  dossierId: z.string().uuid().optional(),
});

// Confirmation EXPLICITE (avec date/heure potentiellement corrigee par
// l'utilisateur - jamais la date detectee utilisee telle quelle sans passer
// par ce formulaire) d'un evenement a partir d'un email - reutilise
// directement le modele Evenement du Lot 12a, source="email".
emailIngestionRouter.post("/api/email-ingestion/emails/:id/confirmer-evenement", requireAuth, async (req, res) => {
  try {
    const email = await chargerEmailAccessible(req.params.id, req.auth!.userId);
    if (!email) {
      return res.status(404).json({ error: "Email introuvable" });
    }

    const parsed = confirmerEvenementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
    }

    const dateDebut = new Date(parsed.data.dateDebut);
    if (Number.isNaN(dateDebut.getTime())) {
      return res.status(400).json({ error: "Date de début invalide" });
    }
    let dateFin: Date | undefined;
    if (parsed.data.dateFin) {
      dateFin = new Date(parsed.data.dateFin);
      if (Number.isNaN(dateFin.getTime())) {
        return res.status(400).json({ error: "Date de fin invalide" });
      }
    }

    let dossier = null;
    if (parsed.data.dossierId) {
      dossier = await chargerDossierAccessible(parsed.data.dossierId, req.auth!.cabinetId);
      if (!dossier) {
        return res.status(404).json({ error: "Dossier introuvable" });
      }
    }

    const evenement = await prisma.evenement.create({
      data: {
        cabinetId: req.auth!.cabinetId,
        dossierId: dossier?.id,
        type: parsed.data.type,
        source: "email",
        titre: parsed.data.titre,
        description: parsed.data.description,
        dateDebut,
        dateFin,
        touteLaJournee: parsed.data.touteLaJournee,
        lieu: parsed.data.lieu,
        createdById: req.auth!.userId,
      },
    });

    // Lot 12b : hook additif non bloquant - synchronise vers les agendas
    // externes concernes, meme comportement qu'un evenement cree manuellement.
    await enqueuerSyncEvenement(evenement.id);

    await prisma.emailImporte.update({ where: { id: email.id }, data: { statut: "traite" } });

    console.log(`[email-ingestion] confirmation d'événement : ${req.auth!.userId} -> événement ${evenement.id} depuis l'email ${email.id}`);

    return res.status(201).json(evenement);
  } catch (error) {
    console.error("[email-ingestion] échec de confirmation d'événement :", error);
    return res.status(500).json({ error: "Impossible de confirmer cet événement (voir logs serveur)" });
  }
});

// --- Lecture du contenu complet + reponse (a la demande, jamais persiste) ---

// Simple passe-plat vers le fournisseur (Gmail/IMAP) a chaque appel - AUCUNE
// ecriture Prisma dans cette route, contrairement a toutes les autres
// ci-dessus : le corps complet d'un email n'est jamais stocke, exactement
// comme documente dans README-LOT16.md pour dateDetecteeContexte (un simple
// extrait), mais ici applique au corps entier - decision explicite du
// prompt de ce lot ("rien ne doit être écrit en base").
emailIngestionRouter.get("/api/email-ingestion/emails/:id/contenu", requireAuth, async (req, res) => {
  try {
    const email = await chargerEmailAccessible(req.params.id, req.auth!.userId);
    if (!email) {
      return res.status(404).json({ error: "Email introuvable" });
    }

    const contenu =
      email.connexion.provider === "gmail"
        ? await obtenirContenuCompletGmail(email.connexion, email.identifiantExterne)
        : await obtenirContenuCompletImap(email.connexion, email.identifiantExterne);

    return res.json(contenu);
  } catch (error) {
    console.error("[email-ingestion] échec de récupération du contenu complet :", error instanceof Error ? error.message : error);
    return res.status(502).json({
      error: `Impossible de récupérer le contenu de cet email : ${error instanceof Error ? error.message : "erreur inconnue"}.`,
    });
  }
});

const repondreSchema = z.object({
  corps: z.string().min(1),
});

// Reponse EXPLICITE (texte redige par l'utilisateur, jamais genere/envoye
// automatiquement) - depuis l'adresse du cabinet elle-meme (Gmail : API
// Gmail avec le jeton OAuth de l'utilisateur ; IMAP : SMTP avec les
// identifiants de la connexion), jamais depuis un expediteur AzoMedIA
// partage (contrairement a mailer.ts/Brevo, utilise uniquement pour les
// notifications de la plateforme elle-meme).
emailIngestionRouter.post("/api/email-ingestion/emails/:id/repondre", requireAuth, async (req, res) => {
  try {
    const email = await chargerEmailAccessible(req.params.id, req.auth!.userId);
    if (!email) {
      return res.status(404).json({ error: "Email introuvable" });
    }

    const parsed = repondreSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
    }

    const params = {
      identifiantExterne: email.identifiantExterne,
      destinataire: email.expediteurEmail,
      sujet: email.objet || "(sans objet)",
      corps: parsed.data.corps,
    };

    if (email.connexion.provider === "gmail") {
      await envoyerReponseGmail(email.connexion, params);
    } else {
      await envoyerReponseImap(email.connexion, params);
    }

    console.log(`[email-ingestion] réponse envoyée : ${req.auth!.userId} -> email ${email.id} (destinataire ${email.expediteurEmail})`);

    return res.json({ ok: true });
  } catch (error) {
    console.error("[email-ingestion] échec d'envoi de réponse :", error instanceof Error ? error.message : error);
    return res.status(502).json({
      error: error instanceof Error ? error.message : "Impossible d'envoyer la réponse (voir logs serveur)",
    });
  }
});
