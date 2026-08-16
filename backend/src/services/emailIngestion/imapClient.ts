import { ImapFlow, MessageStructureObject } from "imapflow";
import nodemailer from "nodemailer";
import type { ConnexionEmailExterne } from "@prisma/client";
import { EmailRecu, PieceJointeDetectee } from "./types";

/**
 * Lot 16 - client IMAP generique (imapflow), pour tout fournisseur non-Gmail
 * (Outlook.com, Proton Mail pont IMAP, serveur maison...). Choix de
 * `imapflow` documente dans README-LOT16.md (bibliotheque suggeree par le
 * prompt, protocole IMAP trop complexe/etatique pour etre reimplemente a la
 * main comme le CalDAV du Lot 12b).
 *
 * Strictement LECTURE SEULE : jamais de modification de flags (vu/non vu),
 * jamais de suppression, jamais d'ecriture - seuls connect/mailboxOpen(via
 * getMailboxLock)/fetch/download/logout sont utilises.
 *
 * Comme pour gmailClient.ts, le contenu binaire des pieces jointes n'est
 * JAMAIS telecharge au simple listage : seule leur metadonnee (nom, type,
 * taille, identifiant de partie MIME) est extraite depuis le bodyStructure,
 * le contenu n'etant recupere via download() qu'a la confirmation explicite
 * d'import (voir telechargerPieceJointe).
 */

interface IdentifiantsImap {
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  imapUsername: string;
  imapPassword: string;
}

function identifiantsDe(connexion: ConnexionEmailExterne): IdentifiantsImap {
  if (!connexion.imapHost || !connexion.imapPort || !connexion.imapUsername || !connexion.imapPassword) {
    throw new Error("Connexion IMAP incomplète (hôte/port/identifiants manquants).");
  }
  return {
    imapHost: connexion.imapHost,
    imapPort: connexion.imapPort,
    imapSecure: connexion.imapSecure,
    imapUsername: connexion.imapUsername,
    imapPassword: connexion.imapPassword,
  };
}

async function ouvrirClient(identifiants: IdentifiantsImap): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: identifiants.imapHost,
    port: identifiants.imapPort,
    secure: identifiants.imapSecure,
    auth: { user: identifiants.imapUsername, pass: identifiants.imapPassword },
    logger: false,
  });
  await client.connect();
  return client;
}

interface RepereCorps {
  partTexte?: string;
  partTexteEstHtml?: boolean;
  pieces: PieceJointeDetectee[];
}

/** Une partie MIME est consideree "piece jointe" des qu'elle porte un nom de
 * fichier (Content-Disposition ou Content-Type "name") et n'est pas elle-meme
 * une partie de corps texte - heuristique documentee comme limite assumee
 * (README-LOT16.md), coherente avec la grande majorite des clients mail. */
function explorerStructure(node: MessageStructureObject | undefined, repere: RepereCorps): void {
  if (!node) return;
  const nomFichier = node.dispositionParameters?.filename || node.parameters?.name;
  const estTexte = node.type === "text/plain" || node.type === "text/html";

  if (nomFichier && !estTexte && node.part) {
    repere.pieces.push({
      id: node.part,
      nomFichier,
      typeMime: node.type || "application/octet-stream",
      tailleOctets: node.size || 0,
    });
  } else if (node.type === "text/plain" && node.part && !repere.partTexte) {
    repere.partTexte = node.part;
    repere.partTexteEstHtml = false;
  } else if (node.type === "text/html" && node.part && !repere.partTexte) {
    // Repli uniquement si aucune partie text/plain n'a encore ete trouvee.
    repere.partTexte = node.part;
    repere.partTexteEstHtml = true;
  }

  if (node.childNodes) {
    for (const enfant of node.childNodes) explorerStructure(enfant, repere);
  }
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
 * ici, meme raisonnement de securite que htmlVersTexte.
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

async function lireFluxEnBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const morceaux: Buffer[] = [];
  for await (const morceau of stream) {
    morceaux.push(Buffer.isBuffer(morceau) ? morceau : Buffer.from(morceau));
  }
  return Buffer.concat(morceaux);
}

/**
 * Liste les emails les plus recents de INBOX (les `maxResultats` derniers
 * par numero de sequence). `download()` d'imapflow decode automatiquement
 * l'encodage de transfert (base64/quoted-printable) et le charset du corps
 * texte - jamais besoin de le refaire manuellement ici.
 *
 * Reessaie automatiquement (jusqu'a 3 tentatives, court delai croissant) en
 * cas d'erreur "Connection not available" (code NoConnection d'imapflow) -
 * constate en usage reel UNIQUEMENT lors du polling automatique planifie
 * (services/emailIngestion/polling.ts, toutes les 5 minutes), jamais lors
 * d'une action interactive de l'utilisateur ("Lire"/"Répondre", voir
 * obtenirContenuComplet/envoyerReponse ci-dessous, qui reussissent
 * systematiquement) - hypothese la plus probable : une limite du nombre de
 * connexions IMAP simultanees cote fournisseur (Yahoo notamment), le cycle
 * de polling planifie pouvant tomber pendant que l'utilisateur a lui-meme
 * une session IMAP active. Toute AUTRE erreur (authentification,
 * configuration, hote injoignable...) remonte immediatement, sans reessai.
 */
export async function listerEmailsRecents(
  connexion: ConnexionEmailExterne,
  options: { maxResultats?: number } = {}
): Promise<EmailRecu[]> {
  const identifiants = identifiantsDe(connexion);
  const maxResultats = options.maxResultats ?? 20;
  const TENTATIVES_MAX = 3;

  let derniereErreur: unknown;
  for (let tentative = 1; tentative <= TENTATIVES_MAX; tentative++) {
    try {
      return await listerEmailsRecentsUneFois(identifiants, maxResultats);
    } catch (error) {
      derniereErreur = error;
      const code = (error as { code?: string })?.code;
      if (code !== "NoConnection" || tentative === TENTATIVES_MAX) throw error;
      console.warn(
        `[imap] connexion indisponible (tentative ${tentative}/${TENTATIVES_MAX}) - nouvel essai dans ${tentative * 2}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, tentative * 2000));
    }
  }
  throw derniereErreur;
}

async function listerEmailsRecentsUneFois(identifiants: IdentifiantsImap, maxResultats: number): Promise<EmailRecu[]> {
  const client = await ouvrirClient(identifiants);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const total = client.mailbox ? client.mailbox.exists : 0;
      if (total === 0) return [];
      const debut = Math.max(1, total - maxResultats + 1);

      const emails: EmailRecu[] = [];
      for await (const message of client.fetch(
        `${debut}:${total}`,
        { uid: true, envelope: true, internalDate: true, bodyStructure: true }
      )) {
        const repere: RepereCorps = { pieces: [] };
        explorerStructure(message.bodyStructure, repere);

        let corpsTexte = "";
        if (repere.partTexte) {
          try {
            const { content } = await client.download(message.uid, repere.partTexte, { uid: true });
            const brut = (await lireFluxEnBuffer(content)).toString("utf8");
            corpsTexte = repere.partTexteEstHtml ? htmlVersTexte(brut) : brut;
          } catch {
            corpsTexte = ""; // message illisible/partie corrompue - n'empeche pas de lister l'email lui-meme
          }
        }

        const from = message.envelope?.from?.[0];
        emails.push({
          identifiantExterne: String(message.uid),
          expediteurEmail: (from?.address || "").toLowerCase(),
          expediteurNom: from?.name || null,
          objet: message.envelope?.subject || null,
          dateReception:
            message.envelope?.date ||
            (message.internalDate instanceof Date ? message.internalDate : new Date()),
          corpsTexte,
          piecesJointes: repere.pieces,
        });
      }
      // Le plus recent en premier (meme convention que gmailClient.ts).
      return emails.reverse();
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Recupere le contenu binaire d'UNE piece jointe (identifiee par son
 * identifiant de partie MIME, ex: "2") - appele UNIQUEMENT a la confirmation
 * explicite d'import (voir routes/emailIngestion.ts). */
export async function telechargerPieceJointe(
  connexion: ConnexionEmailExterne,
  identifiantExterne: string,
  partId: string
): Promise<Buffer> {
  const identifiants = identifiantsDe(connexion);
  const client = await ouvrirClient(identifiants);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const { content } = await client.download(Number(identifiantExterne), partId, { uid: true });
      return await lireFluxEnBuffer(content);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Verifie qu'une connexion IMAP peut etre etablie avec ces identifiants -
 * utilise a la connexion initiale (routes/emailIngestion.ts) pour valider le
 * formulaire avant de persister quoi que ce soit en base. */
export async function testerConnexion(identifiants: IdentifiantsImap): Promise<void> {
  const client = await ouvrirClient(identifiants);
  await client.logout().catch(() => undefined);
}

/**
 * Recupere le corps complet (texte) d'UN email par son UID, a la demande
 * explicite de l'utilisateur (bouton "Lire") - JAMAIS ecrit en base (voir
 * routes/emailIngestion.ts, route GET .../contenu : simple passe-plat).
 * Meme logique d'extraction que listerEmailsRecents ci-dessus, mais pour un
 * seul message identifie par son UID plutot qu'une plage.
 */
export async function obtenirContenuComplet(connexion: ConnexionEmailExterne, identifiantExterne: string): Promise<string> {
  const identifiants = identifiantsDe(connexion);
  const client = await ouvrirClient(identifiants);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uid = Number(identifiantExterne);
      const message = await client.fetchOne(uid, { bodyStructure: true }, { uid: true });
      if (!message) return "";
      const repere: RepereCorps = { pieces: [] };
      explorerStructure(message.bodyStructure, repere);
      if (!repere.partTexte) return "";
      const { content } = await client.download(uid, repere.partTexte, { uid: true });
      const brut = (await lireFluxEnBuffer(content)).toString("utf8");
      // htmlVersTexteLisible (jamais htmlVersTexte, qui aplatit tout sur une
      // seule ligne pour un extrait compact) : ici c'est l'email complet qui
      // va etre affiche a l'avocat, la mise en page (paragraphes) doit
      // rester lisible.
      return repere.partTexteEstHtml ? htmlVersTexteLisible(brut) : brut;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

interface IdentifiantsSmtp {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapUsername: string;
  imapPassword: string;
}

function identifiantsSmtpDe(connexion: ConnexionEmailExterne): IdentifiantsSmtp {
  if (!connexion.smtpHost || !connexion.smtpPort || !connexion.imapUsername || !connexion.imapPassword) {
    throw new Error(
      "Aucun serveur SMTP configuré pour cette boîte — ajoute-le dans Paramètres > Boîte mail pour pouvoir répondre."
    );
  }
  return {
    smtpHost: connexion.smtpHost,
    smtpPort: connexion.smtpPort,
    smtpSecure: connexion.smtpSecure,
    imapUsername: connexion.imapUsername,
    imapPassword: connexion.imapPassword,
  };
}

/**
 * Envoie une reponse a un email via SMTP (nodemailer), avec les en-tetes de
 * fil de discussion corrects (In-Reply-To/References) - a la confirmation
 * explicite de l'utilisateur uniquement (voir routes/emailIngestion.ts,
 * POST .../repondre). Reutilise les MEMES identifiants que la connexion
 * IMAP (imapUsername/imapPassword) : c'est le cas pour la grande majorite
 * des fournisseurs (Yahoo, Outlook.com, la plupart des boites de cabinet).
 */
export async function envoyerReponse(
  connexion: ConnexionEmailExterne,
  params: { identifiantExterne: string; destinataire: string; sujet: string; corps: string }
): Promise<void> {
  const identifiantsImap = identifiantsDe(connexion);
  const identifiantsSmtp = identifiantsSmtpDe(connexion);

  let messageIdOrigine: string | undefined;
  let sujetOrigine: string | undefined;
  const client = await ouvrirClient(identifiantsImap);
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const message = await client.fetchOne(Number(params.identifiantExterne), { envelope: true }, { uid: true });
      if (message) {
        messageIdOrigine = message.envelope?.messageId;
        sujetOrigine = message.envelope?.subject;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  const sujetBase = sujetOrigine || params.sujet;
  const sujetReponse = /^re\s*:/i.test(sujetBase) ? sujetBase : `Re: ${sujetBase}`;

  const transport = nodemailer.createTransport({
    host: identifiantsSmtp.smtpHost,
    port: identifiantsSmtp.smtpPort,
    secure: identifiantsSmtp.smtpSecure,
    auth: { user: identifiantsSmtp.imapUsername, pass: identifiantsSmtp.imapPassword },
  });

  try {
    await transport.sendMail({
      from: identifiantsSmtp.imapUsername,
      to: params.destinataire,
      subject: sujetReponse,
      text: params.corps,
      inReplyTo: messageIdOrigine,
      references: messageIdOrigine,
    });
  } catch (error) {
    console.error(
      `[imap] échec d'envoi de réponse SMTP (${identifiantsSmtp.smtpHost}:${identifiantsSmtp.smtpPort}) :`,
      error instanceof Error ? error.message : error
    );
    throw new Error(
      `Échec de l'envoi via ${identifiantsSmtp.smtpHost} : ${error instanceof Error ? error.message : "erreur inconnue"}.`
    );
  }
}
