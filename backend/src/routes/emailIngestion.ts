import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { isMissingConfigurationError } from "../lib/configurationError";
import { buildGmailAuthUrl, exchangeCodeForTokens, telechargerPieceJointe as telechargerPieceJointeGmail } from "../services/emailIngestion/gmailClient";
import { testerConnexion as testerConnexionImap, telechargerPieceJointe as telechargerPieceJointeImap } from "../services/emailIngestion/imapClient";
import { suggererDossiers } from "../services/emailIngestion/suggestionDossier";
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

emailIngestionRouter.get("/api/email-ingestion/statut", requireAuth, async (req, res) => {
  const connexions = await prisma.connexionEmailExterne.findMany({
    where: { userId: req.auth!.userId },
    select: {
      id: true,
      provider: true,
      actif: true,
      adresseEmail: true,
      imapHost: true,
      imapUsername: true,
      derniereErreur: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return res.json(connexions);
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
    select: { id: true, provider: true, actif: true, imapHost: true, imapUsername: true, createdAt: true },
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
  const email = await chargerEmailAccessible(req.params.id, req.auth!.userId);
  if (!email) {
    return res.status(404).json({ error: "Email introuvable" });
  }
  await prisma.emailImporte.update({ where: { id: email.id }, data: { statut: "traite" } });
  return res.json({ ok: true });
});

const importerPieceSchema = z.object({
  attachmentId: z.string().min(1),
  dossierId: z.string().uuid(),
});

// Import EXPLICITE d'une piece jointe vers un dossier choisi par
// l'utilisateur - reutilise directement stockageDocuments.ts (Lot 15), meme
// chiffrement au repos que pour un upload manuel.
emailIngestionRouter.post("/api/email-ingestion/emails/:id/importer-piece", requireAuth, async (req, res) => {
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
});
