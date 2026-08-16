import { actionOutputSchema, ActionOutput } from "../../schemas/action";
import { LEGAL_ASSISTANT_SYSTEM_PROMPT, buildUserPrompt } from "../../prompts/legalAssistant";
import { LlmProvider, LlmOutputError } from "./types";
import { withTransientRetry } from "../../lib/retry";
import { MissingConfigurationError } from "../../lib/configurationError";
import { appelerAvecRepli } from "./registreModeles";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const JSON_SHAPE_INSTRUCTIONS = `Reponds uniquement avec un objet JSON valide (aucun texte hors du JSON, aucun bloc markdown) respectant exactement ces champs :
{
  "type_action": "notes" | "redac" | "jurisprudence",
  "categorie_texte": string,
  "numero_dossier": string | null,
  "nom_affaire": string | null,
  "nom_client": string | null,
  "date_audience": string | null,
  "nom_juridiction": string | null,
  "nom_chambre": string | null,
  "decision": string | null,
  "prochaine_audience": string | null,
  "pieces_prevoir": string | null,
  "synthese": string | null,
  "argumentaire": string | null
}`;

export class GroqProvider implements LlmProvider {
  constructor(private apiKey: string) {}

  async extractAction(rawInput: string): Promise<ActionOutput> {
    const response = await appelerAvecRepli("groq", (nomModele) =>
      withTransientRetry(() =>
        fetch(GROQ_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: nomModele,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: `${LEGAL_ASSISTANT_SYSTEM_PROMPT}\n\n${JSON_SHAPE_INSTRUCTIONS}` },
              { role: "user", content: buildUserPrompt(rawInput) },
            ],
          }),
        }).then(async (res) => {
          if (!res.ok) {
            const body = await res.text();
            const error = new Error(`Groq a repondu ${res.status}: ${body}`) as Error & {
              status: number;
            };
            error.status = res.status;
            throw error;
          }
          return res;
        })
      )
    );

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    const text = data.choices[0]?.message?.content ?? "";

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LlmOutputError("Groq n'a pas retourne un JSON valide", text);
    }

    const validated = actionOutputSchema.safeParse(parsed);
    if (!validated.success) {
      throw new LlmOutputError(
        `Sortie Groq non conforme au schema : ${validated.error.message}`,
        text
      );
    }

    return validated.data;
  }

  async redact(systemPrompt: string, userPrompt: string, options?: { maxTokens?: number }): Promise<string> {
    const response = await appelerAvecRepli("groq", (nomModele) =>
      withTransientRetry(() =>
        fetch(GROQ_API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: nomModele,
            // Explicite plutot que de compter sur le defaut de l'API : certaines
            // redactions (recherche de jurisprudence approfondie) visent
            // desormais jusqu'a 3000 mots avec tableaux comparatifs. Les appels
            // intermediaires (ex: resume d'un extrait de PDF avant combinaison
            // finale) demandent une limite plus basse pour rester sous le quota
            // de tokens/minute des fournisseurs a plan gratuit (Groq : 12000 TPM).
            max_tokens: options?.maxTokens ?? 8192,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          }),
        }).then(async (res) => {
          if (!res.ok) {
            const body = await res.text();
            const error = new Error(`Groq a repondu ${res.status}: ${body}`) as Error & {
              status: number;
            };
            error.status = res.status;
            throw error;
          }
          return res;
        })
      )
    );

    const data = (await response.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0]?.message?.content ?? "";
  }
}

export function createGroqProvider(): GroqProvider {
  // process.env directement, pas env.GROQ_API_KEY (config/env.ts) - voir
  // services/llm/index.ts, resolveLlmProvider() pour le detail.
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new MissingConfigurationError("GROQ_API_KEY manquant");
  }
  return new GroqProvider(apiKey);
}
