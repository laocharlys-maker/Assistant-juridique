import cron from "node-cron";
import type { ConnexionEmailExterne } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import * as gmailClient from "./gmailClient";
import * as imapClient from "./imapClient";
import { detecterDate } from "./detectionDate";
import { EmailRecu } from "./types";

/**
 * Lot 16 - polling periodique des boites mail connectees. Recupere
 * uniquement des METADONNEES (voir EmailImporte, schema.prisma) : ne cree
 * JAMAIS de DocumentDossier ni d'Evenement ici - ce fichier alimente
 * uniquement la liste "Boite de reception", l'utilisateur confirmant
 * ensuite explicitement chaque action (voir routes/emailIngestion.ts).
 *
 * Contrairement a services/calendrierSync/syncQueue.ts (Lot 12b), pas de
 * table de file d'attente ici : chaque cycle relit directement les emails
 * recents de chaque connexion active (aucun etat de "travail en attente" a
 * gerer - la deduplication repose sur la contrainte unique
 * (connexionId, identifiantExterne) d'EmailImporte, via un upsert qui
 * n'ecrase JAMAIS un enregistrement deja connu (voir `update: {}`
 * ci-dessous) : un email deja marque "traite" par l'utilisateur ne doit
 * jamais redevenir "nouveau" simplement parce qu'il est encore present lors
 * d'un cycle suivant.
 */

const CRON_EXPRESSION = "*/5 * * * *"; // toutes les 5 minutes
const MAX_EMAILS_PAR_CYCLE = 20;

function clientPour(provider: ConnexionEmailExterne["provider"]) {
  return provider === "gmail" ? gmailClient : imapClient;
}

async function traiterConnexion(connexion: ConnexionEmailExterne, cabinetId: string): Promise<void> {
  try {
    const client = clientPour(connexion.provider);
    const emails: EmailRecu[] = await client.listerEmailsRecents(connexion, { maxResultats: MAX_EMAILS_PAR_CYCLE });

    for (const email of emails) {
      // Detection LOCALE (aucun envoi a un tiers, voir detectionDate.ts) -
      // le corps complet (email.corpsTexte) n'est utilise qu'en memoire, le
      // temps de ce calcul : il n'est jamais passe a `create` ci-dessous.
      const detection = detecterDate(email.corpsTexte, email.dateReception);

      await prisma.emailImporte.upsert({
        where: {
          connexionId_identifiantExterne: {
            connexionId: connexion.id,
            identifiantExterne: email.identifiantExterne,
          },
        },
        create: {
          connexionId: connexion.id,
          cabinetId,
          identifiantExterne: email.identifiantExterne,
          expediteurEmail: email.expediteurEmail,
          expediteurNom: email.expediteurNom,
          objet: email.objet,
          dateReception: email.dateReception,
          piecesJointes: email.piecesJointes as unknown as object,
          dateDetectee: detection?.date,
          dateDetecteeContexte: detection?.contexte,
        },
        // Ne modifie jamais un email deja connu (jamais de re-detection qui
        // effacerait un statut "traite" deja pose par l'utilisateur).
        update: {},
      });
    }

    await prisma.connexionEmailExterne.update({
      where: { id: connexion.id },
      data: {
        dernierIdentifiantSynchronise: emails[0]?.identifiantExterne ?? connexion.dernierIdentifiantSynchronise,
        derniereErreur: null,
      },
    });
  } catch (error) {
    const message = messageAvecRaisonServeur(error);
    // Jamais le contenu d'un email, jamais un token/mot de passe - seuls le
    // provider, l'id de connexion (opaque) et le message d'erreur.
    console.error(
      `[email-ingestion] échec du polling (provider=${connexion.provider}, connexion=${connexion.id}) :`,
      message
    );
    await prisma.connexionEmailExterne
      .update({ where: { id: connexion.id }, data: { derniereErreur: message.slice(0, 500) } })
      .catch(() => undefined);
  }
}

/**
 * imapflow annote certaines erreurs avec un texte EXPLICITE donne par le
 * serveur IMAP, que notre code ignorait jusqu'ici (seul error.message,
 * generique, etait affiche) :
 * - error.reason : reponse BYE avant fermeture de connexion (code
 *   "NoConnection", ex: "Too many simultaneous connections") - voir
 *   imap-flow.js, createNoConnectionError().
 * - error.responseText : reponse taguee NO/BAD a une commande (message
 *   generique "Command failed" sinon) - le texte associe peut etre, par
 *   exemple, la vraie raison d'un refus d'authentification ou d'acces,
 *   voir imap-flow.js, settleRequest().
 * Masquait la vraie cause en usage reel (boite Yahoo systematiquement en
 * echec, message generique sans aucune piste exploitable).
 */
function messageAvecRaisonServeur(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!error || typeof error !== "object") return message;
  const err = error as { reason?: unknown; responseText?: unknown };
  const raison =
    (typeof err.reason === "string" && err.reason) || (typeof err.responseText === "string" && err.responseText) || undefined;
  return raison ? `${message} — ${raison}` : message;
}

/** Un cycle complet - exporte separement pour un declenchement manuel
 * (tests, futur bouton "Vérifier maintenant"). */
export async function runPollingCycle(): Promise<void> {
  const connexions = await prisma.connexionEmailExterne.findMany({
    where: { actif: true },
    include: { user: { select: { cabinetId: true } } },
  });
  for (const connexion of connexions) {
    await traiterConnexion(connexion, connexion.user.cabinetId);
  }
}

/**
 * Declenchement manuel d'UNE seule connexion (bouton "Vérifier maintenant",
 * voir routes/emailIngestion.ts) - utile pour diagnostiquer un probleme de
 * synchronisation sans attendre jusqu'a 5 minutes le prochain cycle
 * automatique. Meme fonction traiterConnexion que le cycle planifie : en cas
 * d'echec, derniereErreur est mis a jour normalement, jamais d'exception qui
 * remonterait a l'appelant.
 */
export async function verifierConnexionMaintenant(
  connexion: ConnexionEmailExterne,
  cabinetId: string
): Promise<void> {
  await traiterConnexion(connexion, cabinetId);
}

export function scheduleEmailPolling(): void {
  cron.schedule(
    CRON_EXPRESSION,
    () => {
      runPollingCycle().catch((error) => {
        console.error("[email-ingestion] erreur lors du cycle de polling :", error instanceof Error ? error.message : error);
      });
    },
    { timezone: "Africa/Porto-Novo" }
  );
  console.log(`[email-ingestion] polling des boîtes mail connectées planifié (${CRON_EXPRESSION}).`);
}
