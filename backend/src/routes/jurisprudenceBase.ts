import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { embedText, toVectorLiteral } from "../services/embeddings";

export const jurisprudenceBaseRouter = Router();

jurisprudenceBaseRouter.get("/api/jurisprudence-base", requireAuth, async (_req, res) => {
  const entries = await prisma.jurisprudenceChunk.findMany({
    select: {
      id: true,
      source: true,
      reference: true,
      juridiction: true,
      dateDecision: true,
      contenu: true,
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
});

jurisprudenceBaseRouter.post("/api/jurisprudence-base", requireAuth, async (req, res) => {
  const parsed = createEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const { source, reference, juridiction, dateDecision, contenu } = parsed.data;

  try {
    const embedding = await embedText(`${reference}\n${contenu}`);
    const vectorLiteral = toVectorLiteral(embedding);

    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO jurisprudence_chunks (id, source, reference, juridiction, date_decision, contenu, embedding, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::vector, now())`,
      id,
      source,
      reference,
      juridiction ?? null,
      dateDecision ?? null,
      contenu,
      vectorLiteral
    );

    return res.status(201).json({ id });
  } catch (error) {
    console.error("Erreur ajout jurisprudence :", error);
    return res.status(502).json({ error: "Échec de l'indexation (voir logs serveur)" });
  }
});

jurisprudenceBaseRouter.delete("/api/jurisprudence-base/:id", requireAuth, async (req, res) => {
  await prisma.jurisprudenceChunk.delete({ where: { id: req.params.id } }).catch(() => null);
  return res.json({ ok: true });
});
