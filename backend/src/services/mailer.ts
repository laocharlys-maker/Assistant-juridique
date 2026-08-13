/**
 * Lot 19 - envoi email via l'API REST de Brevo (POST /v3/smtp/email),
 * remplace l'ancien envoi SMTP (Nodemailer). Raison du changement : le
 * relais SMTP de Brevo reecrit le Message-ID cote serveur avant livraison
 * (verifie sur un email reel : `Message-Id: <...@smtp-relay.sendinblue.com>`,
 * alors que Nodemailer genere toujours un ID base sur le domaine de
 * l'adresse d'expedition - jamais `@smtp-relay.sendinblue.com`), rendant
 * impossible tout matching fiable sur cet identifiant pour un futur lot de
 * gestion des reponses mal aiguillees (Lot 18, en pause). L'API REST
 * renvoie le vrai `messageId` utilise dans sa reponse - voir
 * https://developers.brevo.com/reference/send-transac-email.
 *
 * L'ancien code SMTP/Nodemailer reste consultable dans l'historique Git
 * (`git log -- backend/src/services/mailer.ts`) si un retour en arriere
 * s'averait necessaire - jamais reintroduit ici en parallele (un seul
 * mecanisme d'envoi actif a la fois, pas de branche morte).
 *
 * Signatures ET comportement metier (Reply-To dynamique par cabinet, ligne
 * de contact de secours - voir texteAvecContact/htmlAvecContact) inchanges :
 * aucun des appelants existants (routes/factures.ts, routes/admin.ts,
 * routes/cabinet.ts, routes/clients.ts, routes/actionsCallback.ts,
 * services/roleSemaineRecap.ts, services/veilleJuridique.ts) n'a besoin
 * d'etre modifie.
 */

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

// Limites documentees par Brevo (aide officielle, "Add an attachment to a
// transactional email") : 4 Mo par piece jointe, 20 Mo au total (email +
// pieces jointes). Verifiees AVANT tout appel reseau, pour un echec
// immediat et clair plutot qu'un rejet tardif par l'API (ou pire, un envoi
// tronque silencieux).
const TAILLE_MAX_PIECE_JOINTE_OCTETS = 4 * 1024 * 1024;
const TAILLE_MAX_TOTALE_OCTETS = 20 * 1024 * 1024;

// Erreurs transitoires (429 rate limit, 5xx erreur serveur Brevo, ou echec
// reseau) : 3 tentatives au total, avec un court delai croissant entre
// chacune - reste raisonnable pour une requete HTTP synchrone (l'utilisateur
// attend la reponse), sans faire echouer un envoi pour un simple pic de
// charge cote Brevo. Les erreurs definitives (401 cle invalide, 400 requete
// malformee...) ne sont JAMAIS reessayees : reessayer ne changerait rien.
const TENTATIVES_MAX = 3;
const DELAIS_RETRY_MS = [500, 1500];

function attendre(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estErreurTransitoire(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface DocumentEmailInput {
  destinataireEmail: string;
  cabinetNom: string;
  replyToEmail: string | null;
  nomAffaire: string;
  attachment: { filename: string; content: Buffer; contentType: string };
}

export interface MailResult {
  ok: boolean;
  error?: string;
  // Identifiant reellement utilise par Brevo pour ce message (present
  // seulement si ok === true) - jamais consomme par les appelants actuels,
  // prepare pour un eventuel futur lot de matching (le Lot 18 mis en pause
  // n'est PAS reimplemente ici, voir en-tete de fichier).
  messageId?: string;
}

// Certains clients mail (Gmail notamment, comportement documente et
// reproduit en conditions reelles) ignorent l'en-tete Reply-To et
// pre-remplissent "Repondre" avec l'adresse technique partagee
// (SMTP_FROM_EMAIL) plutot que celle du cabinet. Tant qu'aucun mecanisme de
// renvoi automatique fiable n'est en place (voir Lot 18, mise en pause), on
// affiche l'adresse en clair dans le corps du message - le destinataire
// peut alors la copier manuellement si "Repondre" se trompe.
function ligneContact(replyToEmail: string | null): string | null {
  if (!replyToEmail) return null;
  return `Pour nous contacter directement : ${replyToEmail}`;
}

// Exportees uniquement pour les tests unitaires (voir __tests__/mailer.test.ts) -
// jamais appelees ailleurs que dans ce fichier.
export function texteAvecContact(texte: string, replyToEmail: string | null): string {
  const ligne = ligneContact(replyToEmail);
  return ligne ? `${texte}\n\n${ligne}` : texte;
}

export function htmlAvecContact(html: string, replyToEmail: string | null): string {
  const ligne = ligneContact(replyToEmail);
  if (!ligne) return html;
  const paragraphe = `<p>${ligne}</p>`;
  return html.includes("</body>") ? html.replace("</body>", `${paragraphe}</body>`) : `${html}${paragraphe}`;
}

interface PieceJointe {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface EnvoiBrevoInput {
  destinataireEmail: string;
  cabinetNom: string;
  replyToEmail: string | null;
  subject: string;
  text?: string;
  html?: string;
  attachments?: PieceJointe[];
}

function verifierTaillePiecesJointes(attachments: PieceJointe[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  let total = 0;
  for (const piece of attachments) {
    if (piece.content.length > TAILLE_MAX_PIECE_JOINTE_OCTETS) {
      return `La pièce jointe "${piece.filename}" dépasse la taille maximale autorisée (4 Mo).`;
    }
    total += piece.content.length;
  }
  if (total > TAILLE_MAX_TOTALE_OCTETS) {
    return "Les pièces jointes dépassent la taille totale maximale autorisée (20 Mo).";
  }
  return null;
}

// Point d'envoi unique - sendDocumentEmail/sendEmail ci-dessous ne font que
// composer leur payload respectif et deleguer ici (retry, verification de
// taille et appel HTTP factorises une seule fois).
async function envoyerViaBrevo(input: EnvoiBrevoInput): Promise<MailResult> {
  const erreurTaille = verifierTaillePiecesJointes(input.attachments);
  if (erreurTaille) {
    return { ok: false, error: erreurTaille };
  }

  // Lecture "live" de process.env, jamais le singleton `env` de
  // config/env.ts : en mode portable (build desktop), la cle bundlee est
  // posee sur process.env par index.ts potentiellement APRES le premier
  // chargement de ce module - meme raisonnement deja applique dans
  // services/tavily.ts et services/llm/groq.ts pour les autres cles
  // partagees AzoMedIA.
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.SMTP_FROM_EMAIL;
  if (!apiKey || !fromEmail) {
    return { ok: false, error: "Configuration Brevo manquante (voir .env)" };
  }

  const texteFinal = input.text ? texteAvecContact(input.text, input.replyToEmail) : input.text;
  const htmlFinal = input.html ? htmlAvecContact(input.html, input.replyToEmail) : input.html;

  const corps: Record<string, unknown> = {
    sender: { name: input.cabinetNom, email: fromEmail },
    to: [{ email: input.destinataireEmail }],
    subject: input.subject,
  };
  if (input.replyToEmail) corps.replyTo = { email: input.replyToEmail };
  if (texteFinal) corps.textContent = texteFinal;
  if (htmlFinal) corps.htmlContent = htmlFinal;
  if (input.attachments && input.attachments.length > 0) {
    corps.attachment = input.attachments.map((piece) => ({
      name: piece.filename,
      content: piece.content.toString("base64"),
    }));
  }

  let derniereErreur = "Erreur d'envoi inconnue";
  for (let tentative = 0; tentative < TENTATIVES_MAX; tentative++) {
    try {
      const reponse = await fetch(BREVO_API_URL, {
        method: "POST",
        headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(corps),
      });

      if (reponse.ok) {
        const data = (await reponse.json().catch(() => ({}))) as { messageId?: string };
        console.log(`[mailer] email envoyé avec succès (messageId=${data.messageId ?? "absent"})`);
        return { ok: true, messageId: data.messageId };
      }

      const texteErreur = (await reponse.text().catch(() => "")).slice(0, 300);

      if (!estErreurTransitoire(reponse.status)) {
        console.error(`[mailer] échec définitif de l'envoi (HTTP ${reponse.status}) :`, texteErreur);
        return { ok: false, error: `Brevo a refusé l'envoi (HTTP ${reponse.status})${texteErreur ? ` : ${texteErreur}` : ""}` };
      }

      derniereErreur = `Brevo indisponible (HTTP ${reponse.status})${texteErreur ? ` : ${texteErreur}` : ""}`;
      console.warn(`[mailer] erreur transitoire (HTTP ${reponse.status}), tentative ${tentative + 1}/${TENTATIVES_MAX}`);
    } catch (error) {
      derniereErreur = error instanceof Error ? error.message : "Erreur réseau inconnue";
      console.warn(`[mailer] erreur réseau (tentative ${tentative + 1}/${TENTATIVES_MAX}) :`, derniereErreur);
    }

    if (tentative < TENTATIVES_MAX - 1) {
      await attendre(DELAIS_RETRY_MS[tentative] ?? 1500);
    }
  }

  console.error("[mailer] échec de l'envoi après épuisement des tentatives :", derniereErreur);
  return { ok: false, error: derniereErreur };
}

// Envoi direct du document (Word/PDF genere localement, formalisme complet)
// au destinataire, via Brevo. Remplace l'ancien circuit n8n -> Google Docs
// (voir "REVERT TEMPORAIRE" retire de actionsCallback.ts) : le PDF local
// contient desormais l'integralite des champs juridiques structures.
export async function sendDocumentEmail(input: DocumentEmailInput): Promise<MailResult> {
  return envoyerViaBrevo({
    destinataireEmail: input.destinataireEmail,
    cabinetNom: input.cabinetNom,
    replyToEmail: input.replyToEmail,
    subject: `${input.cabinetNom} - ${input.nomAffaire}`,
    text: `Veuillez trouver ci-joint le document relatif à l'affaire "${input.nomAffaire}".`,
    attachments: [input.attachment],
  });
}

export interface EmailInput {
  destinataireEmail: string;
  cabinetNom: string;
  replyToEmail: string | null;
  subject: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

// Envoi generique (sujet + texte/HTML + pieces jointes optionnelles), via
// Brevo - meme mecanisme que sendDocumentEmail ci-dessus. Remplace les
// webhooks n8n "envoyer-facture", "envoyer-email-client", "email-test",
// "role-semaine-recap" et "veille-juridique" (retires du produit, voir
// README-LOT8TER.md) : le backend composait deja les donnees (et, pour
// role-semaine-recap/veille-juridique, le HTML complet) avant de les
// transmettre pour l'envoi effectif - seul ce dernier maillon change, le
// contenu des emails est inchange.
export async function sendEmail(input: EmailInput): Promise<MailResult> {
  return envoyerViaBrevo({
    destinataireEmail: input.destinataireEmail,
    cabinetNom: input.cabinetNom,
    replyToEmail: input.replyToEmail,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments,
  });
}
