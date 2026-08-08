import { ImapFlow, MessageStructureObject } from "imapflow";
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
 */
export async function listerEmailsRecents(
  connexion: ConnexionEmailExterne,
  options: { maxResultats?: number } = {}
): Promise<EmailRecu[]> {
  const identifiants = identifiantsDe(connexion);
  const maxResultats = options.maxResultats ?? 20;
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
