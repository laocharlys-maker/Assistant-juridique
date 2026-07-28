import { env } from "../config/env";
import { ActionOutput } from "../schemas/action";

export type N8nWebhookName =
  | "notes-audience"
  | "document-juridique"
  | "recherche-juridique"
  | "envoyer-email"
  | "envoyer-email-client"
  | "whatsapp-reply"
  | "creer-rappel-delai"
  | "veille-juridique"
  | "envoyer-facture"
  | "role-semaine-recap";

export interface N8nCallResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export async function callN8nWebhook(
  webhook: N8nWebhookName,
  payload: ActionOutput | Record<string, unknown>
): Promise<N8nCallResult> {
  if (!env.N8N_WEBHOOK_BASE_URL) {
    return { ok: false, error: "N8N_WEBHOOK_BASE_URL non configure" };
  }

  const url = `${env.N8N_WEBHOOK_BASE_URL.replace(/\/$/, "")}/webhook/${webhook}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.N8N_WEBHOOK_SECRET ? { "x-webhook-secret": env.N8N_WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { ok: false, status: response.status, error: await response.text() };
    }

    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Erreur inconnue" };
  }
}

export function webhookForAction(typeAction: ActionOutput["type_action"]): N8nWebhookName {
  // Tous les documents "texte juridique classique" (plaidoirie,
  // conclusions, assignation, mise en demeure...) suivent la meme chaine
  // n8n : copie du template generique -> remplacement de texte brut ->
  // export -> envoi. Seul le compte-rendu d'audience a un template et des
  // effets de bord distincts (Calendar, Sheets).
  //
  // Jurisprudence, Recherche juridique et Resume de jurisprudence (PDF)
  // sont volontairement isolees sur leur propre webhook/branche n8n : leur
  // contenu est structure en Markdown (titres, listes, tableaux) et
  // necessite un traitement dedie pour etre converti en vraie mise en
  // forme Google Docs - un traitement qui ne doit jamais pouvoir impacter
  // la generation des documents juridiques classiques ci-dessus en cas de
  // bug. (La veille juridique hebdomadaire n'a pas besoin de ce traitement :
  // c'est un email, pas un document Google Docs, deja converti proprement
  // depuis son Markdown via la librairie "marked" - voir veilleJuridiqueEmail.ts.)
  if (typeAction === "notes") return "notes-audience";
  if (
    typeAction === "jurisprudence" ||
    typeAction === "recherche_juridique" ||
    typeAction === "resume_pdf"
  ) {
    return "recherche-juridique";
  }
  return "document-juridique";
}
