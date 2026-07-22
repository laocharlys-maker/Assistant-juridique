import { prisma } from "../lib/prisma";
import { embedText, toVectorLiteral } from "./embeddings";

export interface JurisprudenceMatch {
  id: string;
  source: string;
  reference: string;
  juridiction: string | null;
  dateDecision: string | null;
  contenu: string;
  distance: number;
}

/**
 * Recherche par similarite vectorielle dans la base de jurisprudence.
 * Renvoie [] si la base est vide ou si les embeddings echouent, plutot que
 * de faire planter la generation (le LLM doit alors dire qu'il n'a pas de
 * source verifiee, pas inventer).
 */
export async function searchJurisprudence(
  query: string,
  limit = 5
): Promise<JurisprudenceMatch[]> {
  const count = await prisma.jurisprudenceChunk.count();
  if (count === 0) return [];

  let queryEmbedding: number[];
  try {
    queryEmbedding = await embedText(query);
  } catch (error) {
    console.error("Erreur embedding requete RAG :", error);
    return [];
  }

  const vectorLiteral = toVectorLiteral(queryEmbedding);

  const rows = await prisma.$queryRawUnsafe<
    {
      id: string;
      source: string;
      reference: string;
      juridiction: string | null;
      date_decision: string | null;
      contenu: string;
      distance: number;
    }[]
  >(
    `SELECT id, source, reference, juridiction, date_decision, contenu,
            embedding <-> $1::vector AS distance
     FROM jurisprudence_chunks
     ORDER BY embedding <-> $1::vector
     LIMIT $2`,
    vectorLiteral,
    limit
  );

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    reference: r.reference,
    juridiction: r.juridiction,
    dateDecision: r.date_decision,
    contenu: r.contenu,
    distance: r.distance,
  }));
}

export function formatJurisprudenceContext(matches: JurisprudenceMatch[]): string {
  if (matches.length === 0) {
    return "Aucune source verifiee trouvee dans la base de jurisprudence pour cette recherche.";
  }
  return matches
    .map(
      (m, i) =>
        `[Source ${i + 1}] ${m.reference} (${m.juridiction ?? "juridiction non precisee"}${m.dateDecision ? `, ${m.dateDecision}` : ""})\n${m.contenu}`
    )
    .join("\n\n");
}
