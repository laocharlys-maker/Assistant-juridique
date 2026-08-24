import { ConnexionEmailExterne } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { MissingConfigurationError } from "../../lib/configurationError";
import { EmailRecu, PieceJointeDetectee } from "./types";
import { nettoyerHtmlEmail } from "./sanitizeEmailHtml";

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
 * Scope : lecture (gmail.readonly) + envoi (gmail.send) UNIQUEMENT - jamais
 * gmail.modify (qui autoriserait aussi supprimer/etiqueter) - principe du
 * moindre privilege, coherent avec "aucune automatisation silencieuse".
 * gmail.send a ete ajoute au Lot "lecture complete + reponse" (2026-08-16) :
 * une connexion existante creee AVANT cet ajout ne possede qu'un jeton
 * autorise pour gmail.readonly - repondre echoue alors avec un 403 tant que
 * l'utilisateur n'a pas reconnecte son compte Gmail (voir
 * routes/emailIngestion.ts, le bouton "Connecter Gmail" redemande le
 * consentement a chaque connexion, prompt=consent ci-dessous).
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";

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

async function gmailFetch(connexion: ConnexionEmailExterne, path: string, init: RequestInit = {}): Promise<Response> {
  const accessToken = await assurerAccessTokenValide(connexion);
  return fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
  });
}

function encodeBase64Url(data: string): string {
  return Buffer.from(data, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

/**
 * Comme htmlVersTexte ci-dessus, mais destine a l'AFFICHAGE COMPLET d'un
 * email (bouton "Lire", voir obtenirContenuComplet plus bas) - preserve les
 * sauts de ligne/paragraphes au lieu de tout aplatir sur une seule ligne.
 * htmlVersTexte fait cet aplatissement DELIBEREMENT pour fabriquer un court
 * extrait de contexte compact (corpsTexte, utilise par detectionDate.ts) -
 * reutiliser cette meme fonction pour un email entier rendait la lecture
 * complete illisible (constate en usage reel : un mail HTML normalement mis
 * en page ressortait comme un unique bloc de texte sans aucune separation).
 * Jamais de HTML brut renvoye au client - toujours du texte pur converti
 * ici, meme raisonnement de securite que htmlVersTexte (evite tout risque
 * d'injection si ce texte est un jour insere dans le DOM sans passer par
 * textContent).
 */
function htmlVersTexteLisible(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
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
    // Corps de la reponse Google journalise (jamais expose a l'utilisateur,
    // seulement dans aurore-shell.log) : le message utilisateur "HTTP 403"
    // seul ne permet pas de distinguer une API non activee ("Gmail API has
    // not been used in project...") d'un scope insuffisant ou d'un jeton
    // revoque - constate concretement le 2026-08-16, diagnostic impossible
    // sans cette information.
    const corpsErreur = await listeRes.text().catch(() => "");
    console.error(`[gmail] echec de listage des emails (HTTP ${listeRes.status}) : ${corpsErreur}`);
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

/**
 * Recupere le corps complet d'UN email, a la demande explicite de
 * l'utilisateur (bouton "Lire") - JAMAIS ecrit en base (voir
 * routes/emailIngestion.ts, route GET .../contenu : simple passe-plat,
 * aucune ecriture Prisma).
 *
 * `html` est le HTML nettoye (voir sanitizeEmailHtml.ts) pret pour un
 * affichage fidele (bouton "Lire" en iframe sandboxee cote frontend), non
 * null uniquement si l'email a une partie HTML. `texte` est toujours
 * disponible (repli texte brut - email purement texte, ou echec du rendu
 * HTML cote frontend).
 */
export async function obtenirContenuComplet(
  connexion: ConnexionEmailExterne,
  identifiantExterne: string
): Promise<{ html: string | null; texte: string }> {
  const res = await gmailFetch(connexion, `/messages/${identifiantExterne}?format=full`);
  if (!res.ok) {
    throw new Error(`Gmail : échec de récupération de l'email (HTTP ${res.status})`);
  }
  const detail = (await res.json()) as GmailMessageDetail;
  const extraction: ExtractionCorps = { pieces: [] };
  if (detail.payload) explorerParties(detail.payload, extraction);
  // HTML priorise sur le texte brut quand les deux existent (meme
  // comportement que Gmail/tout client mail) - un email multipart (le cas
  // le plus courant pour les newsletters/notifications) fournit un
  // texte/plain "genere" par l'outil d'envoi, souvent illisible tel quel
  // (URLs de tracking imbriquees entre parentheses juste apres le texte du
  // lien, ex: "Google ( https://... )") : constate en usage reel, un email
  // parfaitement propre dans Gmail (rendu HTML) ressortait brouillon ici
  // (rendu texte/plain brut) alors que le HTML, plus fidele, etait
  // disponible mais jamais utilise.
  if (extraction.texteHtml) {
    // htmlVersTexteLisible (jamais htmlVersTexte, qui aplatit tout sur une
    // seule ligne pour un extrait compact) pour le repli texte : la mise en
    // page (paragraphes) doit y rester lisible.
    return { html: nettoyerHtmlEmail(extraction.texteHtml), texte: htmlVersTexteLisible(extraction.texteHtml) };
  }
  if (extraction.textePlain) {
    return { html: null, texte: extraction.textePlain };
  }
  return { html: null, texte: "" };
}

/** Encodage RFC 2047 ("encoded-word") d'un en-tete pouvant contenir des
 * caracteres non-ASCII (accents...) - un en-tete brut UTF-8 non encode
 * serait techniquement invalide et mal interprete par certains clients. */
function encodeEnTete(valeur: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(valeur)) return valeur;
  return `=?UTF-8?B?${Buffer.from(valeur, "utf8").toString("base64")}?=`;
}

/**
 * Envoie une reponse a un email, dans le MEME fil de discussion (threadId +
 * In-Reply-To/References corrects) - a la confirmation explicite de
 * l'utilisateur uniquement (voir routes/emailIngestion.ts, POST .../repondre).
 * Necessite le scope gmail.send (voir commentaire d'en-tete de ce fichier) :
 * une connexion Gmail plus ancienne sans ce scope echoue ici avec un 403
 * explicite, message clair renvoye a l'appelant plutot qu'une erreur brute.
 */
export async function envoyerReponse(
  connexion: ConnexionEmailExterne,
  params: { identifiantExterne: string; destinataire: string; sujet: string; corps: string }
): Promise<void> {
  const metaRes = await gmailFetch(
    connexion,
    `/messages/${params.identifiantExterne}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject`
  );
  if (!metaRes.ok) {
    throw new Error(`Gmail : email d'origine introuvable pour la réponse (HTTP ${metaRes.status})`);
  }
  const meta = (await metaRes.json()) as {
    threadId: string;
    payload?: { headers?: Array<{ name: string; value: string }> };
  };
  const headers = meta.payload?.headers || [];
  const messageIdOrigine = extraireEnTete(headers, "Message-ID") || "";
  const referencesOrigine = extraireEnTete(headers, "References") || "";
  const sujetOrigine = extraireEnTete(headers, "Subject") || "";
  const sujetReponse = /^re\s*:/i.test(sujetOrigine || params.sujet) ? (sujetOrigine || params.sujet) : `Re: ${sujetOrigine || params.sujet}`;
  const references = [referencesOrigine, messageIdOrigine].filter(Boolean).join(" ");

  const lignesEntete = [
    connexion.adresseEmail ? `From: ${encodeEnTete(connexion.adresseEmail)}` : null,
    `To: ${encodeEnTete(params.destinataire)}`,
    `Subject: ${encodeEnTete(sujetReponse)}`,
    messageIdOrigine ? `In-Reply-To: ${messageIdOrigine}` : null,
    references ? `References: ${references}` : null,
    `Content-Type: text/plain; charset="UTF-8"`,
    `MIME-Version: 1.0`,
  ].filter((ligne): ligne is string => ligne !== null);

  const messageBrut = `${lignesEntete.join("\r\n")}\r\n\r\n${params.corps}`;

  const res = await gmailFetch(connexion, `/messages/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encodeBase64Url(messageBrut), threadId: meta.threadId }),
  });
  if (!res.ok) {
    const corpsErreur = await res.text().catch(() => "");
    console.error(`[gmail] échec d'envoi de réponse (HTTP ${res.status}) : ${corpsErreur}`);
    if (res.status === 403) {
      throw new Error(
        "Gmail : autorisation insuffisante pour répondre — reconnecte ton compte Gmail (Paramètres > Boîte mail) pour accorder la permission d'envoi."
      );
    }
    throw new Error(`Gmail : échec de l'envoi de la réponse (HTTP ${res.status})`);
  }
}
