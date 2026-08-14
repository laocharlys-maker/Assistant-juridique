import crypto from "node:crypto";
import { prisma } from "../../lib/prisma";
import { embedText, toVectorLiteral } from "../embeddings";
import { nettoyerTexte } from "./nettoyerTexte";
import { chunkerTexte } from "./chunkerTexte";

/**
 * Logique d'indexation d'une decision dans JurisprudenceChunk, partagee par
 * deux points d'entree : la saisie manuelle (routes/jurisprudenceBase.ts,
 * POST /api/jurisprudence-base, Lot 18) et la passerelle resume PDF ->
 * jurisprudence (routes/webActions.ts, type_action "resume_pdf" avec la case
 * "Ajouter aussi cette decision a ma base de jurisprudence" cochee). Les deux
 * chemins doivent nettoyer/decouper/indexer EXACTEMENT de la meme facon -
 * cette fonction evite de dupliquer cette logique.
 */

/**
 * Construit la requete SQL parametree (jamais d'interpolation de valeur
 * utilisateur dans la chaine SQL elle-meme - voir README-LOT18.md, audit
 * de securite prealable au Lot 18) pour l'insertion d'UN chunk. Exportee
 * pour permettre un test direct de la non-vulnerabilite a l'injection SQL
 * sans avoir besoin d'une base Postgres reelle (voir __tests__).
 */
export function construireInsertionChunk(params: {
  id: string;
  source: string;
  reference: string;
  juridiction: string | null;
  dateDecision: string | null;
  contenu: string;
  lien: string | null;
  groupeId: string;
  vectorLiteral: string;
}): { sql: string; params: unknown[] } {
  return {
    sql: `INSERT INTO jurisprudence_chunks (id, source, reference, juridiction, date_decision, contenu, lien, groupe_id, embedding, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, now())`,
    params: [
      params.id,
      params.source,
      params.reference,
      params.juridiction,
      params.dateDecision,
      params.contenu,
      params.lien,
      params.groupeId,
      params.vectorLiteral,
    ],
  };
}

export interface IndexerDecisionInput {
  source: string;
  reference: string;
  juridiction: string | null;
  dateDecision: string | null;
  // Texte BRUT (non nettoye) - cette fonction applique elle-meme
  // nettoyerTexte() puis chunkerTexte(), l'appelant ne doit jamais le faire
  // en amont (evite un double nettoyage divergent entre les deux chemins).
  contenuBrut: string;
  lien: string | null;
  // Genere automatiquement si absent - un appelant peut le fournir a
  // l'avance quand le groupeId doit aussi servir a autre chose avant
  // l'indexation elle-meme (ex: nommer le lien interne du PDF stocke, voir
  // routes/webActions.ts, qui construit le lien AVANT d'appeler cette
  // fonction et doit donc connaitre le groupeId au prealable).
  groupeId?: string;
}

export interface IndexerDecisionResultat {
  groupeId: string;
  ids: string[];
  chunkCount: number;
}

export async function indexerDecision(input: IndexerDecisionInput): Promise<IndexerDecisionResultat> {
  const texteNettoye = nettoyerTexte(input.contenuBrut);
  const chunks = chunkerTexte(texteNettoye);
  const groupeId = input.groupeId ?? crypto.randomUUID();

  // Embeddings calcules HORS transaction, AVANT tout acces DB : chaque appel
  // embedText() est un aller-retour reseau vers Gemini (avec retry -
  // withTransientRetry, voir services/embeddings.ts - donc potentiellement
  // plusieurs secondes). Une transaction Prisma interactive a un timeout par
  // defaut de 5000ms ; constate en usage reel, un seul embedding un peu lent
  // suffisait a la faire expirer ("P2028 Transaction already closed") et a
  // faire echouer TOUTE l'indexation, meme les chunks deja inseres avec
  // succes. Ne jamais faire dependre une transaction DB d'un appel reseau
  // externe lent - la transaction ci-dessous ne fait plus QUE des insertions
  // (rapides), largement sous ce delai quel que soit le nombre de chunks.
  //
  // Sequentiel (jamais Promise.all) : evite de rafaler plusieurs appels
  // Gemini en parallele pour une seule decision, memes contraintes de quota
  // que le reste du projet (voir services/veilleJuridique.ts, boucle par
  // theme).
  const chunksAvecEmbedding: { contenu: string; vectorLiteral: string }[] = [];
  for (const chunkContenu of chunks) {
    const embedding = await embedText(`${input.reference}\n${chunkContenu}`);
    chunksAvecEmbedding.push({ contenu: chunkContenu, vectorLiteral: toVectorLiteral(embedding) });
  }

  // Transaction : soit TOUS les chunks d'une decision sont inseres, soit
  // aucun (jamais un groupe partiellement insere) - purement DB desormais,
  // aucun appel reseau a l'interieur.
  const ids = await prisma.$transaction(async (tx) => {
    const idsInternes: string[] = [];
    for (const { contenu, vectorLiteral } of chunksAvecEmbedding) {
      const id = crypto.randomUUID();
      const { sql, params } = construireInsertionChunk({
        id,
        source: input.source,
        reference: input.reference,
        juridiction: input.juridiction,
        dateDecision: input.dateDecision,
        contenu,
        lien: input.lien,
        groupeId,
        vectorLiteral,
      });
      await tx.$executeRawUnsafe(sql, ...params);
      idsInternes.push(id);
    }
    return idsInternes;
  });

  return { groupeId, ids, chunkCount: ids.length };
}
