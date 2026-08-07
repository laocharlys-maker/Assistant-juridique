import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { MissingConfigurationError } from "../lib/configurationError";
import { buildGoogleAuthUrl, exchangeCodeForTokens } from "../services/calendrierSync/googleCalendar";
import { decouvrirCalendrierPrincipal } from "../services/calendrierSync/caldav";

export const calendrierExterneRouter = Router();

// Etat OAuth ephemere (protection CSRF standard du flux "authorization
// code") - en memoire, pas de persistance necessaire : duree de vie de
// quelques minutes, un seul process backend (pas de cluster multi-instance
// pour ce produit). Purge passive a chaque acces.
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const oauthStates = new Map<string, { userId: string; expiresAt: number }>();

function purgerEtatsExpires(): void {
  const maintenant = Date.now();
  for (const [state, info] of oauthStates) {
    if (info.expiresAt < maintenant) oauthStates.delete(state);
  }
}

// Statut de connexion (jamais les tokens/mots de passe) - affiche dans
// "Mon profil" > "Calendrier externe".
calendrierExterneRouter.get("/api/calendrier-externe/statut", requireAuth, async (req, res) => {
  const connexions = await prisma.connexionCalendrierExterne.findMany({
    where: { userId: req.auth!.userId },
    select: {
      id: true,
      provider: true,
      actif: true,
      derniereErreur: true,
      caldavUrl: true,
      caldavUsername: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return res.json(connexions);
});

// Etape 1 du flux OAuth Google - redirige vers l'ecran de consentement.
calendrierExterneRouter.get("/api/calendrier-externe/google/connecter", requireAuth, (req, res) => {
  purgerEtatsExpires();
  const state = crypto.randomUUID();
  oauthStates.set(state, { userId: req.auth!.userId, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
  try {
    return res.redirect(buildGoogleAuthUrl(state));
  } catch (error) {
    if (error instanceof MissingConfigurationError) {
      return res.status(503).json({ error: error.message });
    }
    throw error;
  }
});

// Etape 2 - callback Google (pas de requireAuth : Google redirige un
// navigateur qui a peut-etre perdu son cookie de session entre-temps selon
// le navigateur/la configuration - l'identite est retrouvee via le `state`
// signe et stocke serveur, pas via la session).
calendrierExterneRouter.get("/api/calendrier-externe/google/callback", async (req, res) => {
  purgerEtatsExpires();
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";

  const info = oauthStates.get(state);
  if (!info) {
    return res.status(400).send("Connexion Google expirée ou invalide — réessaie depuis Aurore (Mon profil > Calendrier externe).");
  }
  oauthStates.delete(state);

  if (!code) {
    return res.redirect("/parametres-calendrier.html?erreur=google_refuse");
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    await prisma.connexionCalendrierExterne.upsert({
      where: { userId_provider: { userId: info.userId, provider: "google" } },
      create: {
        userId: info.userId,
        provider: "google",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokens.expiresAt,
        calendrierUrl: "primary",
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
    return res.redirect("/parametres-calendrier.html?connecte=google");
  } catch (error) {
    console.error("[calendrier-externe] échec de connexion Google :", error instanceof Error ? error.message : error);
    return res.redirect("/parametres-calendrier.html?erreur=google_echec");
  }
});

const caldavSchema = z.object({
  caldavUrl: z.string().url("URL du serveur CalDAV invalide"),
  caldavUsername: z.string().min(1),
  caldavPassword: z.string().min(1),
});

// Connexion CalDAV generique (Outlook.com, Proton Calendar, iCloud...) - une
// seule route pour tous les fournisseurs compatibles, voir services/calendrierSync/caldav.ts.
calendrierExterneRouter.post("/api/calendrier-externe/caldav", requireAuth, async (req, res) => {
  const parsed = caldavSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  let calendrierUrl: string;
  try {
    calendrierUrl = await decouvrirCalendrierPrincipal(parsed.data);
  } catch (error) {
    return res.status(502).json({
      error: `Impossible de se connecter à cet agenda CalDAV : ${error instanceof Error ? error.message : "erreur inconnue"}.`,
    });
  }

  const connexion = await prisma.connexionCalendrierExterne.upsert({
    where: { userId_provider: { userId: req.auth!.userId, provider: "caldav" } },
    create: {
      userId: req.auth!.userId,
      provider: "caldav",
      caldavUrl: parsed.data.caldavUrl,
      caldavUsername: parsed.data.caldavUsername,
      caldavPassword: parsed.data.caldavPassword,
      calendrierUrl,
      actif: true,
    },
    update: {
      caldavUrl: parsed.data.caldavUrl,
      caldavUsername: parsed.data.caldavUsername,
      caldavPassword: parsed.data.caldavPassword,
      calendrierUrl,
      actif: true,
      derniereErreur: null,
    },
    select: { id: true, provider: true, actif: true, caldavUrl: true, caldavUsername: true, createdAt: true },
  });

  return res.status(201).json(connexion);
});

// Deconnexion : supprime uniquement la connexion (tokens/identifiants) et,
// par cascade DB, les lignes de suivi de synchro en attente - jamais les
// Evenement Aurore, jamais une tentative de suppression retroactive cote
// externe (l'utilisateur gere lui-meme son agenda personnel - contrainte
// explicite du prompt).
calendrierExterneRouter.delete("/api/calendrier-externe/:id", requireAuth, async (req, res) => {
  await prisma.connexionCalendrierExterne
    .deleteMany({ where: { id: req.params.id, userId: req.auth!.userId } })
    .catch(() => null);
  return res.json({ ok: true });
});
