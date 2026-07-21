import { env } from "../config/env";
import { ActionOutput } from "../schemas/action";

export type N8nWebhookName = "notes-audience" | "plaidoirie" | "jurisprudence" | "whatsapp-reply";

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
  switch (typeAction) {
    case "notes":
      return "notes-audience";
    case "redac":
      return "plaidoirie";
    case "jurisprudence":
      return "jurisprudence";
  }
}
