import { GoogleGenerativeAI } from "@google/generative-ai";
import { withTransientRetry } from "../lib/retry";
import { MissingConfigurationError } from "../lib/configurationError";

let client: GoogleGenerativeAI | null = null;
let clientApiKey: string | undefined;

function getClient(): GoogleGenerativeAI {
  // process.env directement, pas env.GEMINI_API_KEY (config/env.ts) - voir
  // services/llm/index.ts, resolveLlmProvider() pour le detail (meme
  // categorie de bug : cle bundlee posee sur process.env par index.ts en
  // mode portable, mais potentiellement lue trop tot via le singleton
  // fige `env`).
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new MissingConfigurationError(
      "GEMINI_API_KEY manquant : necessaire pour les embeddings (RAG jurisprudence), meme si LLM_PROVIDER n'est pas gemini."
    );
  }
  // Recree le client si la cle a change depuis la derniere fois (ex :
  // absente au tout premier appel, puis renseignee) - jamais un client mis
  // en cache avec une cle perimee/vide.
  if (!client || clientApiKey !== apiKey) {
    client = new GoogleGenerativeAI(apiKey);
    clientApiKey = apiKey;
  }
  return client;
}

export async function embedText(text: string): Promise<number[]> {
  const model = getClient().getGenerativeModel({ model: "gemini-embedding-001" });
  const result = await withTransientRetry(() => model.embedContent(text));
  return result.embedding.values;
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
