import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { embedText, toVectorLiteral } from "../services/embeddings";
import { isMissingConfigurationError } from "../lib/configurationError";
import { isNetworkFetchError, isGeminiQuotaError } from "../lib/networkError";
import { nettoyerTexte } from "../services/jurisprudence/nettoyerTexte";
import { chunkerTexte } from "../services/jurisprudence/chunkerTexte";
import { extraireTextePdf, pdfBufferDepuisDataUrl } from "../services/pdfExtraction";

export const jurisprudenceBaseRouter = Router();

// Module payant : peut etre desactive par la plateforme pour un cabinet
// dont la formule ne l'inclut pas. Chemin explicite obligatoire : sans lui,
// ce middleware s'appliquerait a TOUTES les requetes de l'app (ce routeur
// est monte sans prefixe sur app), pas seulement a /api/jurisprudence-base*.
jurisprudenceBaseRouter.use("/api/jurisprudence-base", requireAuth, requireModule("jurisprudence"));

jurisprudenceBaseRouter.get("/api/jurisprudence-base", requireAuth, async (_req, res) => {
  // Sans try/catch, une erreur ici (ex: extension Postgres "vector" ou
  // table jurisprudence_chunks manquante sur cet environnement) resterait
  // une promesse rejetee non rattrapee - avec le filet de securite de
  // index.ts (process.on("unhandledRejection", ...)), cela arrete TOUT le
  // backend, pas seulement cette requete. D'ou ce try/catch explicite,
  // comme sur POST /api/jurisprudence-base ci-dessous.
  try {
    const entries = await prisma.jurisprudenceChunk.findMany({
      select: {
        id: true,
        source: true,
        reference: true,
        juridiction: true,
        dateDecision: true,
        contenu: true,
        lien: true,
        groupeId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return res.json(entries);
  } catch (error) {
    console.error("Erreur chargement base de jurisprudence :", error);
    return res.status(500).json({ error: "Impossible de charger la base de jurisprudence (voir logs serveur)" });
  }
});

const createEntrySchema = z.object({
  source: z.string().min(1),
  reference: z.string().min(1),
  juridiction: z.string().optional(),
  dateDecision: z.string().optional(),
  contenu: z.string().min(20, "Le contenu doit être suffisamment détaillé pour être utile"),
  // Lot 13 : lien reel vers la decision - optionnel a la saisie (le corpus
  // existant n'en a pas), mais fortement recommande : une citation issue
  // d'un chunk sans lien n'est jamais affichee dans une recherche de
  // jurisprudence (voir services/jurisprudence/grounding.ts).
  lien: z.string().url("Le lien doit être une URL valide (https://...)").optional().or(z.literal("")),
});

/**
 * Construit la requete SQL parametree (jamais d'interpolation de valeur
 * utilisateur dans la chaine SQL elle-meme - voir README-LOT18.md, audit
 * de securite prealable a ce lot) pour l'insertion d'UN chunk. Exportee
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

jurisprudenceBaseRouter.post("/api/jurisprudence-base", requireAuth, async (req, res) => {
  const parsed = createEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const { source, reference, juridiction, dateDecision, contenu, lien } = parsed.data;

  try {
    // Lot 18 : nettoyage (espaces multiples, mots coupes par la mise en
    // page, en-tetes/pieds de page repetes - voir nettoyerTexte.ts) PUIS
    // decoupage en chunks si le contenu nettoye depasse le seuil (voir
    // chunkerTexte.ts) - une decision courte reste un seul chunk, comme
    // avant ce lot.
    const texteNettoye = nettoyerTexte(contenu);
    const chunks = chunkerTexte(texteNettoye);
    const groupeId = crypto.randomUUID();

    // Transaction : soit TOUS les chunks d'une decision sont inseres, soit
    // aucun (jamais un groupe partiellement insere si l'embedding d'un
    // chunk intermediaire echoue - ex: quota Gemini epuise en cours de
    // route sur une tres longue decision).
    const idsCrees = await prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      for (const chunkContenu of chunks) {
        // Embedding sequentiel (jamais Promise.all) : evite de rafaler
        // plusieurs appels Gemini en parallele pour une seule decision,
        // memes contraintes de quota que le reste du projet (voir
        // services/veilleJuridique.ts, boucle par theme).
        const embedding = await embedText(`${reference}\n${chunkContenu}`);
        const vectorLiteral = toVectorLiteral(embedding);
        const id = crypto.randomUUID();
        const { sql, params } = construireInsertionChunk({
          id,
          source,
          reference,
          juridiction: juridiction ?? null,
          dateDecision: dateDecision ?? null,
          contenu: chunkContenu,
          lien: lien || null,
          groupeId,
          vectorLiteral,
        });
        await tx.$executeRawUnsafe(sql, ...params);
        ids.push(id);
      }
      return ids;
    });

    return res.status(201).json({ ids: idsCrees, groupeId, chunkCount: idsCrees.length });
  } catch (error) {
    // MissingConfigurationError (cle Gemini absente - embedText() en a
    // besoin quel que soit LLM_PROVIDER, voir embeddings.ts) distingue du
    // reste : message clair plutot que noye dans "echec de l'indexation",
    // qui laissait a tort penser a un probleme reseau/Postgres ponctuel.
    if (isMissingConfigurationError(error)) {
      console.error("[jurisprudence] indexation impossible, configuration manquante :", error.message);
      return res.status(503).json({
        error: "L'indexation de jurisprudence n'est pas configurée sur ce poste (clé API manquante). Contactez le support AzoMedIA.",
      });
    }
    if (isNetworkFetchError(error)) {
      console.error("[jurisprudence] indexation impossible, echec reseau :", error);
      return res.status(503).json({
        error: "Impossible de contacter le service d'IA (vérifiez votre connexion internet), puis réessayez.",
      });
    }
    if (isGeminiQuotaError(error)) {
      console.error("[jurisprudence] indexation impossible, quota Gemini epuise :", error);
      return res.status(503).json({
        error: "Le quota de l'API IA utilisée pour l'indexation est épuisé. Contactez le support AzoMedIA pour recharger le compte.",
      });
    }
    console.error("Erreur ajout jurisprudence :", error);
    return res.status(502).json({ error: "Échec de l'indexation (voir logs serveur)" });
  }
});

const extrairePdfSchema = z.object({
  pdfDataUrl: z.string().min(1),
});

// Lot 18 : confort de saisie uniquement - extrait le texte d'un PDF pour
// PRE-REMPLIR le champ "contenu" du formulaire cote frontend. Ne cree
// jamais rien en base elle-meme : le texte extrait suit ensuite exactement
// le meme chemin (relecture/correction par l'avocat, POST explicite,
// nettoyage, chunking) que la saisie manuelle - voir
// public/jurisprudence-base.html.
jurisprudenceBaseRouter.post("/api/jurisprudence-base/extraire-pdf", requireAuth, async (req, res) => {
  const parsed = extrairePdfSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide" });
  }
  const pdfBuffer = pdfBufferDepuisDataUrl(parsed.data.pdfDataUrl);
  const extraction = await extraireTextePdf(pdfBuffer);
  if (!extraction.ok) {
    return res.status(400).json({ error: extraction.error });
  }
  return res.json({ texte: extraction.texte });
});

const updateLienSchema = z.object({
  lien: z.string().url("Le lien doit être une URL valide (https://...)").optional().or(z.literal("")),
});

/**
 * Determine le filtre a appliquer pour agir sur TOUS les chunks d'une meme
 * decision (PATCH du lien, DELETE) : si le chunk cible appartient a un
 * groupe (decision multi-chunkee, ou meme une decision a un seul chunk
 * mais indexee depuis ce lot - voir jurisprudenceBase.ts POST, groupeId
 * toujours genere desormais), TOUS les chunks du groupe sont vises.
 * Repli sur l'id seul pour le corpus indexe AVANT ce lot (groupeId
 * absent). Exportee pure (aucun acces Prisma) pour un test direct de
 * cette logique de branchement, partagee par PATCH et DELETE.
 */
export function construireFiltreGroupe(
  chunk: { id: string; groupeId: string | null } | null,
  idDemande: string
): { groupeId: string } | { id: string } | null {
  if (!chunk) return null;
  return chunk.groupeId ? { groupeId: chunk.groupeId } : { id: idDemande };
}

// Lot 13 : permet de completer le lien d'une source deja indexee (corpus
// existant avant ce lot, ou saisie initiale sans lien) sans avoir a la
// supprimer/reindexer - seul le lien change, jamais le contenu ni
// l'embedding. Lot 18 : si la decision a ete decoupee en plusieurs chunks,
// le lien de TOUS ses chunks est mis a jour en une seule operation (voir
// construireFiltreGroupe ci-dessus).
jurisprudenceBaseRouter.patch("/api/jurisprudence-base/:id", requireAuth, async (req, res) => {
  const parsed = updateLienSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const chunk = await prisma.jurisprudenceChunk.findUnique({
      where: { id: req.params.id },
      select: { id: true, groupeId: true },
    });
    const filtre = construireFiltreGroupe(chunk, req.params.id);
    if (!filtre) {
      return res.status(404).json({ error: "Source introuvable" });
    }
    const updated = await prisma.jurisprudenceChunk.updateMany({
      where: filtre,
      data: { lien: parsed.data.lien || null },
    });
    if (updated.count === 0) {
      return res.status(404).json({ error: "Source introuvable" });
    }
    return res.json({ ok: true, chunksModifies: updated.count });
  } catch (error) {
    console.error("Erreur mise à jour du lien de jurisprudence :", error);
    return res.status(500).json({ error: "Impossible d'enregistrer le lien (voir logs serveur)" });
  }
});

// Lot 18 (correctif) : supprime TOUS les chunks de la meme decision, pas
// seulement celui vise par :id - une decision multi-chunkee ne doit
// jamais laisser de chunks orphelins apres suppression (voir
// construireFiltreGroupe ci-dessus, meme logique que PATCH).
jurisprudenceBaseRouter.delete("/api/jurisprudence-base/:id", requireAuth, async (req, res) => {
  try {
    const chunk = await prisma.jurisprudenceChunk.findUnique({
      where: { id: req.params.id },
      select: { id: true, groupeId: true },
    });
    const filtre = construireFiltreGroupe(chunk, req.params.id);
    if (!filtre) {
      return res.json({ ok: true, chunksSupprimes: 0 });
    }
    const deleted = await prisma.jurisprudenceChunk.deleteMany({ where: filtre });
    return res.json({ ok: true, chunksSupprimes: deleted.count });
  } catch (error) {
    console.error("Erreur suppression jurisprudence :", error);
    return res.status(500).json({ error: "Impossible de supprimer la source (voir logs serveur)" });
  }
});
