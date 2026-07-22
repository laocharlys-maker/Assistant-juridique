import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env";
import { withTransientRetry } from "../lib/retry";

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!env.GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY manquant : necessaire pour les embeddings (RAG jurisprudence), meme si LLM_PROVIDER n'est pas gemini."
    );
  }
  if (!client) client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  return client;
}

export async function embedText(text: string): Promise<number[]> {
  const model = getClient().getGenerativeModel({ model: "text-embedding-004" });
  const result = await withTransientRetry(() => model.embedContent(text));
  return result.embedding.values;
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
