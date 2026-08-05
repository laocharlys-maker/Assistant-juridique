import nodemailer, { Transporter } from "nodemailer";
import { env } from "../config/env";

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM_EMAIL) {
    return null;
  }
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ?? 587,
      secure: (env.SMTP_PORT ?? 587) === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    });
  }
  return cachedTransporter;
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
}

// Envoi direct du document (Word/PDF genere localement, formalisme complet)
// au destinataire, via Brevo. Remplace l'ancien circuit n8n -> Google Docs
// (voir "REVERT TEMPORAIRE" retire de actionsCallback.ts) : le PDF local
// contient desormais l'integralite des champs juridiques structures.
export async function sendDocumentEmail(input: DocumentEmailInput): Promise<MailResult> {
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: "Configuration SMTP manquante (voir .env)" };
  }

  try {
    await transporter.sendMail({
      from: `"${input.cabinetNom}" <${env.SMTP_FROM_EMAIL}>`,
      to: input.destinataireEmail,
      replyTo: input.replyToEmail ?? undefined,
      subject: `${input.cabinetNom} - ${input.nomAffaire}`,
      text: `Veuillez trouver ci-joint le document relatif à l'affaire "${input.nomAffaire}".`,
      attachments: [input.attachment],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Erreur d'envoi inconnue" };
  }
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
// Brevo/Nodemailer - meme transporteur que sendDocumentEmail ci-dessus.
// Remplace les webhooks n8n "envoyer-facture", "envoyer-email-client",
// "email-test", "role-semaine-recap" et "veille-juridique" (retires du
// produit, voir README-LOT8TER.md) : le backend composait deja les donnees
// (et, pour role-semaine-recap/veille-juridique, le HTML complet) avant de
// les transmettre a n8n pour l'envoi effectif - seul ce dernier maillon
// change, le contenu des emails est inchange.
export async function sendEmail(input: EmailInput): Promise<MailResult> {
  const transporter = getTransporter();
  if (!transporter) {
    return { ok: false, error: "Configuration SMTP manquante (voir .env)" };
  }

  try {
    await transporter.sendMail({
      from: `"${input.cabinetNom}" <${env.SMTP_FROM_EMAIL}>`,
      to: input.destinataireEmail,
      replyTo: input.replyToEmail ?? undefined,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Erreur d'envoi inconnue" };
  }
}
