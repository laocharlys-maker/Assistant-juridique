import { ConnexionCalendrierExterne } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { MissingConfigurationError } from "../../lib/configurationError";
import { CalendrierExterneAdapter, EvenementExterneInput } from "./adapter";

/**
 * Lot 12b - adaptateur Google Calendar : OAuth2 individuel (chaque
 * utilisateur connecte SON propre compte, jamais un compte cabinet
 * partage - voir README-LOT12B.md pour la procedure d'obtention des
 * credentials OAuth cote Google Cloud Console) + CRUD d'evenements via
 * l'API REST Calendar v3. Implementation en `fetch` natif (comme le reste
 * du projet - Tavily, Groq... - pas de SDK `googleapis` ajoute pour ca).
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
// Scope minimal (gestion des evenements uniquement, pas l'administration du
// calendrier lui-meme) - principe du moindre privilege.
const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function oauthConfig(): OAuthConfig {
  const clientId = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new MissingConfigurationError(
      "La connexion Google Calendar n'est pas configurée pour cette installation (GOOGLE_CALENDAR_OAUTH_CLIENT_ID/SECRET manquants — voir README-LOT12B.md)."
    );
  }
  // Mode portable (desktop) : toujours 127.0.0.1:3000 (port fixe du
  // sidecar, voir src-tauri/src/main.rs). Mode externe/reseau : doit etre
  // fourni explicitement (domaine reel du serveur).
  const redirectUri =
    process.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI ||
    `http://127.0.0.1:${process.env.PORT || 3000}/api/calendrier-externe/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

export function buildGoogleAuthUrl(state: string): string {
  const { clientId, redirectUri } = oauthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    // access_type=offline + prompt=consent : garantit la reception d'un
    // refresh_token a CHAQUE connexion (Google ne le renvoie sinon que la
    // toute premiere fois pour un compte/app donnes) - necessaire ici car
    // une reconnexion volontaire (ex: apres revocation) doit toujours en
    // obtenir un nouveau.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function exchangeCodeForTokens(
  code: string
): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
  const { clientId, clientSecret, redirectUri } = oauthConfig();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Échec de l'échange du code OAuth Google (HTTP ${res.status})`);
  }
  const data = (await res.json()) as GoogleTokenResponse;
  if (!data.refresh_token) {
    throw new Error(
      "Google n'a renvoyé aucun refresh_token — révoque l'accès existant depuis myaccount.google.com/permissions puis reconnecte-toi."
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
  const { clientId, clientSecret } = oauthConfig();
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Échec du renouvellement du token Google (HTTP ${res.status})`);
  }
  const data = (await res.json()) as GoogleTokenResponse;
  return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000) };
}

/**
 * Renvoie un access_token garanti valide, en le renouvelant via le refresh
 * token si expire (ou expire dans moins de 2 minutes) et en persistant le
 * nouveau token en base (chiffre au repos - transparent, voir
 * security/prismaEncryption.ts). Jamais besoin de redemander la connexion a
 * l'utilisateur : comportement standard OAuth2 (contrainte explicite du
 * prompt).
 */
export async function assurerAccessTokenValide(connexion: ConnexionCalendrierExterne): Promise<string> {
  const expireBientot =
    !connexion.tokenExpiresAt || connexion.tokenExpiresAt.getTime() < Date.now() + 2 * 60 * 1000;
  if (!expireBientot && connexion.accessToken) {
    return connexion.accessToken;
  }
  if (!connexion.refreshToken) {
    throw new Error("Aucun refresh token disponible pour ce compte Google — reconnexion nécessaire.");
  }
  const { accessToken, expiresAt } = await refreshAccessToken(connexion.refreshToken);
  await prisma.connexionCalendrierExterne.update({
    where: { id: connexion.id },
    data: { accessToken, tokenExpiresAt: expiresAt },
  });
  return accessToken;
}

function toGoogleEventBody(evenement: EvenementExterneInput): Record<string, unknown> {
  if (evenement.touteLaJournee) {
    const jour = evenement.dateDebut.toISOString().slice(0, 10);
    const finJour = (evenement.dateFin ?? evenement.dateDebut).toISOString().slice(0, 10);
    return {
      summary: evenement.titre,
      description: evenement.description || undefined,
      location: evenement.lieu || undefined,
      start: { date: jour },
      end: { date: finJour },
    };
  }
  const dateFin = evenement.dateFin ?? new Date(evenement.dateDebut.getTime() + 60 * 60 * 1000);
  return {
    summary: evenement.titre,
    description: evenement.description || undefined,
    location: evenement.lieu || undefined,
    start: { dateTime: evenement.dateDebut.toISOString() },
    end: { dateTime: dateFin.toISOString() },
  };
}

async function googleFetch(
  connexion: ConnexionCalendrierExterne,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const accessToken = await assurerAccessTokenValide(connexion);
  return fetch(`${GOOGLE_CALENDAR_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
}

export const googleCalendarAdapter: CalendrierExterneAdapter = {
  async creerEvenement(connexion, evenement) {
    const calendarId = connexion.calendrierUrl || "primary";
    const res = await googleFetch(connexion, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      body: JSON.stringify(toGoogleEventBody(evenement)),
    });
    if (!res.ok) {
      throw new Error(`Google Calendar : échec de création (HTTP ${res.status})`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  },

  async modifierEvenement(connexion, externalEventId, evenement) {
    const calendarId = connexion.calendrierUrl || "primary";
    const res = await googleFetch(
      connexion,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalEventId)}`,
      { method: "PATCH", body: JSON.stringify(toGoogleEventBody(evenement)) }
    );
    if (!res.ok && res.status !== 404) {
      throw new Error(`Google Calendar : échec de modification (HTTP ${res.status})`);
    }
  },

  async supprimerEvenement(connexion, externalEventId) {
    const calendarId = connexion.calendrierUrl || "primary";
    const res = await googleFetch(
      connexion,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalEventId)}`,
      { method: "DELETE" }
    );
    // 404/410 : deja supprime cote Google (ex. par l'utilisateur) - jamais
    // une erreur, l'objectif (l'evenement n'existe plus cote externe) est
    // deja atteint.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new Error(`Google Calendar : échec de suppression (HTTP ${res.status})`);
    }
  },
};
