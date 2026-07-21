import { env } from "../../config/env";
import { actionOutputSchema, ActionOutput } from "../../schemas/action";
import { LEGAL_ASSISTANT_SYSTEM_PROMPT, buildUserPrompt } from "../../prompts/legalAssistant";
import { LlmProvider, LlmOutputError } from "./types";
import { withTransientRetry } from "../../lib/retry";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const JSON_SHAPE_INSTRUCTIONS = `Reponds uniquement avec un objet JSON valide (aucun texte hors du JSON, aucun bloc markdown) respectant exactement ces champs :
{
  "type_action": "notes" | "redac" | "jurisprudence",
  "categorie_texte": string,
  "numero_dossier": string | null,
  "nom_affaire": string | null,
  "nom_client": string | null,
  "date_audience": string | null,
  "nom_juge": string | null,
  "decision": string | null,
  "prochaine_audience": string | null,
  "pieces_prevoir": string | null,
  "synthese": string | null,
  "argumentaire": string | null
}`;

export class GroqProvider implements LlmProvider {
  constructor(private apiKey: string) {}

  async extractAction(rawInput: string): Promise<ActionOutput> {
    const response = await withTransientRetry(() =>
      fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
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
}

export function createGroqProvider(): GroqProvider {
  if (!env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY manquant");
  }
  return new GroqProvider(env.GROQ_API_KEY);
}
