import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { embedText, toVectorLiteral } from "../services/embeddings";
import { MissingConfigurationError } from "../lib/configurationError";

export const jurisprudenceBaseRouter = Router();

// Module payant : peut etre desactive par la plateforme pour un cabinet
// dont la formule ne l'inclut pas. Chemin explicite obligatoire : sans lui,
// ce middleware s'appliquerait a TOUTES les requetes de l'app (ce routeur
// est monte sans prefixe sur app), pas seulement a /api/jurisprudence-base*.
jurisprudenceBaseRouter.use("/api/jurisprudence-base", requireAuth, requireModule("jurisprudence"));

jurisprudenceBaseRouter.get("/api/jurisprudence-base", requireAuth, async (_req, res) => {
  const entries = await prisma.jurisprudenceChunk.findMany({
    select: {
      id: true,
      source: true,
      reference: true,
      juridiction: true,
      dateDecision: true,
      contenu: true,
      lien: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return res.json(entries);
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

jurisprudenceBaseRouter.post("/api/jurisprudence-base", requireAuth, async (req, res) => {
  const parsed = createEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const { source, reference, juridiction, dateDecision, contenu, lien } = parsed.data;

  try {
    const embedding = await embedText(`${reference}\n${contenu}`);
    const vectorLiteral = toVectorLiteral(embedding);

    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO jurisprudence_chunks (id, source, reference, juridiction, date_decision, contenu, lien, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, now())`,
      id,
      source,
      reference,
      juridiction ?? null,
      dateDecision ?? null,
      contenu,
      lien || null,
      vectorLiteral
    );

    return res.status(201).json({ id });
  } catch (error) {
    // MissingConfigurationError (cle Gemini absente - embedText() en a
    // besoin quel que soit LLM_PROVIDER, voir embeddings.ts) distingue du
    // reste : message clair plutot que noye dans "echec de l'indexation",
    // qui laissait a tort penser a un probleme reseau/Postgres ponctuel.
    if (error instanceof MissingConfigurationError) {
      console.error("[jurisprudence] indexation impossible, configuration manquante :", error.message);
      return res.status(503).json({
        error: "L'indexation de jurisprudence n'est pas configurée sur ce poste (clé API manquante). Contactez le support AzoMedIA.",
      });
    }
    console.error("Erreur ajout jurisprudence :", error);
    return res.status(502).json({ error: "Échec de l'indexation (voir logs serveur)" });
  }
});

const updateLienSchema = z.object({
  lien: z.string().url("Le lien doit être une URL valide (https://...)").optional().or(z.literal("")),
});

// Lot 13 : permet de completer le lien d'une source deja indexee (corpus
// existant avant ce lot, ou saisie initiale sans lien) sans avoir a la
// supprimer/reindexer - seul le lien change, jamais le contenu ni
// l'embedding.
jurisprudenceBaseRouter.patch("/api/jurisprudence-base/:id", requireAuth, async (req, res) => {
  const parsed = updateLienSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const updated = await prisma.jurisprudenceChunk.updateMany({
    where: { id: req.params.id },
    data: { lien: parsed.data.lien || null },
  });
  if (updated.count === 0) {
    return res.status(404).json({ error: "Source introuvable" });
  }
  return res.json({ ok: true });
});

jurisprudenceBaseRouter.delete("/api/jurisprudence-base/:id", requireAuth, async (req, res) => {
  await prisma.jurisprudenceChunk.delete({ where: { id: req.params.id } }).catch(() => null);
  return res.json({ ok: true });
});
