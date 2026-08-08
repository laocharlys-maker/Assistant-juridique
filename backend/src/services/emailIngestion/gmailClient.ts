import { ConnexionEmailExterne } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { MissingConfigurationError } from "../../lib/configurationError";
import { EmailRecu, PieceJointeDetectee } from "./types";

/**
 * Lot 16 - client Gmail (API REST, OAuth2 individuel) : meme pattern que
 * services/calendrierSync/googleCalendar.ts (Lot 12b) - `fetch` natif, pas
 * de SDK `googleapis`. Reutilise le MEME couple client OAuth Google Cloud
 * (GOOGLE_CALENDAR_OAUTH_CLIENT_ID/SECRET) que le calendrier - un seul jeu
 * de credentials suffit pour plusieurs scopes/APIs Google - mais une
 * connexion (ConnexionEmailExterne) et une redirect_uri strictement
 * SEPAREES de ConnexionCalendrierExterne : le scope demande differe
 * (gmail.readonly vs calendar.events), et coupler les deux flux
 * compliquerait inutilement la reconnexion/revocation independante de
 * chacun (voir README-LOT16.md).
 *
 * Scope volontairement en LECTURE SEULE (gmail.readonly) : ce module ne
 * modifie/supprime jamais un email, ne pose jamais de libelle - principe du
 * moindre privilege, coherent avec "aucune automatisation silencieuse".
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

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
      "La connexion Gmail n'est pas configurée pour cette installation (GOOGLE_CALENDAR_OAUTH_CLIENT_ID/SECRET manquants — voir README-LOT16.md)."
    );
  }
  // Mode portable : toujours 127.0.0.1:3000 (meme raisonnement que
  // googleCalendar.ts). Mode externe/reseau : fourni explicitement.
  const redirectUri =
    process.env.GMAIL_INGESTION_OAUTH_REDIRECT_URI ||
    `http://127.0.0.1:${process.env.PORT || 3000}/api/email-ingestion/gmail/callback`;
  return { clientId, clientSecret, redirectUri };
}

export function buildGmailAuthUrl(state: string): string {
  const { clientId, redirectUri } = oauthConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
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
    throw new Error(`Échec de l'échange du code OAuth Gmail (HTTP ${res.status})`);
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
    throw new Error(`Échec du renouvellement du token Gmail (HTTP ${res.status})`);
  }
  const data = (await res.json()) as GoogleTokenResponse;
  return { accessToken: data.access_token, expiresAt: new Date(Date.now() + data.expires_in * 1000) };
}

/** Meme contrat que assurerAccessTokenValide de googleCalendar.ts : jamais
 * besoin de redemander la connexion, renouvellement + persistance
 * transparents. */
export async function assurerAccessTokenValide(connexion: ConnexionEmailExterne): Promise<string> {
  const expireBientot =
    !connexion.tokenExpiresAt || connexion.tokenExpiresAt.getTime() < Date.now() + 2 * 60 * 1000;
  if (!expireBientot && connexion.accessToken) {
    return connexion.accessToken;
  }
  if (!connexion.refreshToken) {
    throw new Error("Aucun refresh token disponible pour ce compte Gmail — reconnexion nécessaire.");
  }
  const { accessToken, expiresAt } = await refreshAccessToken(connexion.refreshToken);
  await prisma.connexionEmailExterne.update({
    where: { id: connexion.id },
    data: { accessToken, tokenExpiresAt: expiresAt },
  });
  return accessToken;
}

async function gmailFetch(connexion: ConnexionEmailExterne, path: string): Promise<Response> {
  const accessToken = await assurerAccessTokenValide(connexion);
  return fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function extraireEnTete(headers: Array<{ name: string; value: string }>, nom: string): string | null {
  const trouve = headers.find((h) => h.name.toLowerCase() === nom.toLowerCase());
  return trouve ? trouve.value : null;
}

function parseExpediteur(from: string): { email: string; nom: string | null } {
  const match = from.match(/^(.*?)<([^>]+)>$/);
  if (match) {
    const nom = match[1].trim().replace(/^"|"$/g, "");
    return { email: match[2].trim().toLowerCase(), nom: nom || null };
  }
  return { email: from.trim().toLowerCase(), nom: null };
}

interface GmailMessagePart {
  mimeType: string;
  filename?: string;
  body: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessageDetail {
  internalDate: string;
  payload?: GmailMessagePart & { headers?: Array<{ name: string; value: string }> };
}

function htmlVersTexte(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

interface ExtractionCorps {
  textePlain?: string;
  texteHtml?: string;
  pieces: PieceJointeDetectee[];
}

/** Parcourt recursivement l'arbre MIME d'un message Gmail. Une partie est
 * consideree "piece jointe" des qu'elle porte un `filename` non vide -
 * heuristique volontairement simple (documentee comme limite assumee, voir
 * README-LOT16.md), coherente avec le comportement observe de l'API Gmail
 * (les parties de corps texte n'ont jamais de filename). */
function explorerParties(part: GmailMessagePart, out: ExtractionCorps): void {
  if (part.filename && part.filename.length > 0) {
    out.pieces.push({
      id: part.body.attachmentId || "",
      nomFichier: part.filename,
      typeMime: part.mimeType || "application/octet-stream",
      tailleOctets: part.body.size || 0,
    });
  } else if (part.mimeType === "text/plain" && part.body.data && !out.textePlain) {
    out.textePlain = decodeBase64Url(part.body.data).toString("utf8");
  } else if (part.mimeType === "text/html" && part.body.data && !out.texteHtml) {
    out.texteHtml = decodeBase64Url(part.body.data).toString("utf8");
  }
  if (part.parts) {
    for (const sous of part.parts) explorerParties(sous, out);
  }
}

/**
 * Liste les emails les plus recents de la boite de reception (INBOX) - ne
 * telecharge JAMAIS le contenu binaire des pieces jointes ici (seulement
 * leurs metadonnees), conformement a la contrainte "aucune automatisation
 * silencieuse" : le contenu n'est recupere qu'a la confirmation explicite
 * d'import (voir telechargerPieceJointe ci-dessous).
 */
export async function listerEmailsRecents(
  connexion: ConnexionEmailExterne,
  options: { maxResultats?: number } = {}
): Promise<EmailRecu[]> {
  const maxResultats = options.maxResultats ?? 20;
  const listeRes = await gmailFetch(connexion, `/messages?maxResults=${maxResultats}&labelIds=INBOX`);
  if (!listeRes.ok) {
    throw new Error(`Gmail : échec de listage des emails (HTTP ${listeRes.status})`);
  }
  const liste = (await listeRes.json()) as { messages?: Array<{ id: string }> };
  const messages = liste.messages || [];

  const emails: EmailRecu[] = [];
  for (const { id } of messages) {
    const detailRes = await gmailFetch(connexion, `/messages/${id}?format=full`);
    if (!detailRes.ok) continue; // message supprime entre-temps ou inaccessible - ignore, sans faire echouer tout le cycle
    const detail = (await detailRes.json()) as GmailMessageDetail;
    const headers = detail.payload?.headers || [];
    const from = extraireEnTete(headers, "From") || "";
    const { email, nom } = parseExpediteur(from);

    const extraction: ExtractionCorps = { pieces: [] };
    if (detail.payload) explorerParties(detail.payload, extraction);
    const corpsTexte = extraction.textePlain || (extraction.texteHtml ? htmlVersTexte(extraction.texteHtml) : "");

    emails.push({
      identifiantExterne: id,
      expediteurEmail: email,
      expediteurNom: nom,
      objet: extraireEnTete(headers, "Subject"),
      dateReception: new Date(Number(detail.internalDate)),
      corpsTexte,
      piecesJointes: extraction.pieces,
    });
  }
  return emails;
}

/** Recupere le contenu binaire d'UNE piece jointe - appele UNIQUEMENT au
 * moment de la confirmation explicite d'import par l'utilisateur (voir
 * routes/emailIngestion.ts), jamais lors du simple listage. */
export async function telechargerPieceJointe(
  connexion: ConnexionEmailExterne,
  identifiantExterne: string,
  attachmentId: string
): Promise<Buffer> {
  const res = await gmailFetch(connexion, `/messages/${identifiantExterne}/attachments/${attachmentId}`);
  if (!res.ok) {
    throw new Error(`Gmail : échec de récupération de la pièce jointe (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { data: string };
  return decodeBase64Url(data.data);
}
