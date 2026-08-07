import crypto from "node:crypto";
import { ConnexionCalendrierExterne } from "@prisma/client";
import { CalendrierExterneAdapter, EvenementExterneInput } from "./adapter";

/**
 * Lot 12b - client CalDAV generique (RFC 4791), sans dependance propriétaire
 * par fournisseur - couvre Outlook.com, Proton Calendar, iCloud, Baikal et
 * tout serveur CalDAV standard avec le meme code. Authentification Basic
 * (username/password - ou mot de passe d'application selon le fournisseur,
 * voir README-LOT12B.md). Decouverte du calendrier principal en 3 requetes
 * PROPFIND (principal -> calendar-home-set -> premiere collection de type
 * "calendar"), puis creation/modification/suppression d'evenements via
 * PUT/DELETE au format iCalendar (VEVENT).
 *
 * Extraction XML volontairement simple (regex cible sur les 2-3 elements
 * necessaires), PAS un parseur XML complet - suffisant pour ces requetes
 * PROPFIND precises et structurellement previsibles, documente comme
 * limite assumee dans README-LOT12B.md plutot que d'ajouter une dependance
 * XML pour un besoin aussi restreint.
 */

interface CaldavIdentifiants {
  caldavUsername: string;
  caldavPassword: string;
}

function basicAuthHeader(identifiants: CaldavIdentifiants): string {
  return `Basic ${Buffer.from(`${identifiants.caldavUsername}:${identifiants.caldavPassword}`).toString("base64")}`;
}

async function caldavRequest(
  url: string,
  identifiants: CaldavIdentifiants,
  init: RequestInit & { method: string }
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: basicAuthHeader(identifiants),
      ...(init.headers || {}),
    },
  });
}

function extraireHref(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<[^>]*${tagName}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)</[^>]*href>`, "i");
  const match = xml.match(regex);
  return match ? match[1].trim() : null;
}

async function decouvrirPrincipal(caldavUrl: string, identifiants: CaldavIdentifiants): Promise<string> {
  const res = await caldavRequest(caldavUrl, identifiants, {
    method: "PROPFIND",
    headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
  });
  if (!res.ok) throw new Error(`découverte du principal échouée (HTTP ${res.status})`);
  const href = extraireHref(await res.text(), "current-user-principal");
  if (!href) throw new Error("réponse inattendue du serveur (principal introuvable)");
  return new URL(href, caldavUrl).toString();
}

async function decouvrirHomeSet(principalUrl: string, identifiants: CaldavIdentifiants): Promise<string> {
  const res = await caldavRequest(principalUrl, identifiants, {
    method: "PROPFIND",
    headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
    body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><C:calendar-home-set/></D:prop></D:propfind>',
  });
  if (!res.ok) throw new Error(`découverte du dossier des calendriers échouée (HTTP ${res.status})`);
  const href = extraireHref(await res.text(), "calendar-home-set");
  if (!href) throw new Error("réponse inattendue du serveur (calendar-home-set introuvable)");
  return new URL(href, principalUrl).toString();
}

async function decouvrirPremierCalendrier(homeSetUrl: string, identifiants: CaldavIdentifiants): Promise<string> {
  const res = await caldavRequest(homeSetUrl, identifiants, {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
    body: '<?xml version="1.0" encoding="utf-8" ?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:displayname/></D:prop></D:propfind>',
  });
  if (!res.ok) throw new Error(`liste des calendriers échouée (HTTP ${res.status})`);
  const xml = await res.text();
  // Un "response" par ressource enfant - garde la premiere dont le
  // resourcetype contient la balise "calendar" (espace de noms CalDAV).
  const reponses = xml.split(/<[^:]*:?response[^>]*>/i).slice(1);
  for (const chunk of reponses) {
    const estCalendrier = /resourcetype[^]*?calendar/i.test(chunk);
    if (!estCalendrier) continue;
    const hrefMatch = chunk.match(/<[^>]*href[^>]*>([^<]+)</i);
    if (hrefMatch) return new URL(hrefMatch[1].trim(), homeSetUrl).toString();
  }
  throw new Error("aucun calendrier trouvé pour ce compte");
}

/** Point d'entree utilise par routes/calendrierExterne.ts a la connexion
 * initiale : renvoie l'URL de la collection calendrier a utiliser ensuite
 * pour toutes les operations PUT/DELETE. */
export async function decouvrirCalendrierPrincipal(identifiants: CaldavIdentifiants & { caldavUrl: string }): Promise<string> {
  const principal = await decouvrirPrincipal(identifiants.caldavUrl, identifiants);
  const homeSet = await decouvrirHomeSet(principal, identifiants);
  return decouvrirPremierCalendrier(homeSet, identifiants);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function formatICalDateTimeUTC(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}
function formatICalDateOnly(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}
function escapeICalText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Construit un fichier iCalendar (RFC 5545) a un seul VEVENT - fonction
 * pure, testee isolement (voir __tests__/caldav.test.ts). */
export function buildICalendarEvent(uid: string, evenement: EvenementExterneInput): string {
  const dateFinDefaut = evenement.touteLaJournee
    ? new Date(evenement.dateDebut.getTime() + 24 * 60 * 60 * 1000)
    : new Date(evenement.dateDebut.getTime() + 60 * 60 * 1000);
  const dateFin = evenement.dateFin ?? dateFinDefaut;

  const lignes = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Aurore//Calendrier//FR",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatICalDateTimeUTC(new Date())}`,
    evenement.touteLaJournee
      ? `DTSTART;VALUE=DATE:${formatICalDateOnly(evenement.dateDebut)}`
      : `DTSTART:${formatICalDateTimeUTC(evenement.dateDebut)}`,
    evenement.touteLaJournee
      ? `DTEND;VALUE=DATE:${formatICalDateOnly(dateFin)}`
      : `DTEND:${formatICalDateTimeUTC(dateFin)}`,
    `SUMMARY:${escapeICalText(evenement.titre)}`,
    evenement.description ? `DESCRIPTION:${escapeICalText(evenement.description)}` : null,
    evenement.lieu ? `LOCATION:${escapeICalText(evenement.lieu)}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l): l is string => l !== null);
  return lignes.join("\r\n");
}

function identifiantsDe(connexion: ConnexionCalendrierExterne): { calendrierUrl: string } & CaldavIdentifiants {
  const { calendrierUrl, caldavUsername, caldavPassword } = connexion;
  if (!calendrierUrl || !caldavUsername || !caldavPassword) {
    throw new Error("Connexion CalDAV incomplète (calendrier non découvert ou identifiants manquants).");
  }
  return { calendrierUrl, caldavUsername, caldavPassword };
}

function urlEvenement(calendrierUrl: string, uid: string): string {
  return `${calendrierUrl.replace(/\/$/, "")}/${uid}.ics`;
}

export const caldavAdapter: CalendrierExterneAdapter = {
  async creerEvenement(connexion, evenement) {
    const { calendrierUrl, ...identifiants } = identifiantsDe(connexion);
    const uid = `aurore-${crypto.randomUUID()}`;
    const res = await caldavRequest(urlEvenement(calendrierUrl, uid), identifiants, {
      method: "PUT",
      // If-None-Match: * refuse d'ecraser un evenement existant au meme UID
      // (protection contre une collision improbable, jamais attendue en
      // pratique - un nouvel UUID est genere a chaque creation).
      headers: { "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" },
      body: buildICalendarEvent(uid, evenement),
    });
    if (!res.ok) throw new Error(`CalDAV : échec de création (HTTP ${res.status})`);
    return uid;
  },

  async modifierEvenement(connexion, externalEventId, evenement) {
    const { calendrierUrl, ...identifiants } = identifiantsDe(connexion);
    const res = await caldavRequest(urlEvenement(calendrierUrl, externalEventId), identifiants, {
      method: "PUT",
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
      body: buildICalendarEvent(externalEventId, evenement),
    });
    if (!res.ok && res.status !== 404) throw new Error(`CalDAV : échec de modification (HTTP ${res.status})`);
  },

  async supprimerEvenement(connexion, externalEventId) {
    const { calendrierUrl, ...identifiants } = identifiantsDe(connexion);
    const res = await caldavRequest(urlEvenement(calendrierUrl, externalEventId), identifiants, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) throw new Error(`CalDAV : échec de suppression (HTTP ${res.status})`);
  },
};
