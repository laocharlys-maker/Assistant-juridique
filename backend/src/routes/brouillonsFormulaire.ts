import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";

export const brouillonsFormulaireRouter = Router();

// Autosauvegarde serveur des formulaires longs de "Nouvelle action" - prive a
// CHAQUE compte (toujours filtre par req.auth!.userId, jamais par cabinetId
// seul : un autre utilisateur du meme cabinet ne doit jamais voir le
// brouillon d'un collegue). Voir schema.prisma, BrouillonFormulaire.

// Liste allegee (sans le contenu) pour la banniere "brouillon(s) en cours"
// affichee au chargement de nouvelle-action.html.
brouillonsFormulaireRouter.get("/api/brouillons-formulaire", requireAuth, async (req, res) => {
  const brouillons = await prisma.brouillonFormulaire.findMany({
    where: { userId: req.auth!.userId },
    select: { typeAction: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
  });
  return res.json(brouillons);
});

brouillonsFormulaireRouter.get("/api/brouillons-formulaire/:typeAction", requireAuth, async (req, res) => {
  const brouillon = await prisma.brouillonFormulaire.findUnique({
    where: { userId_typeAction: { userId: req.auth!.userId, typeAction: req.params.typeAction } },
  });
  if (!brouillon) {
    return res.status(404).json({ error: "Aucun brouillon pour ce type de formulaire." });
  }
  return res.json(brouillon);
});

const brouillonSchema = z.object({
  // Forme libre (FormData serialisee cote client + snapshot des listes
  // dynamiques) - jamais validee champ par champ ici, ce n'est qu'un
  // brouillon de saisie, pas une soumission reelle (voir routes/webActions.ts
  // pour la validation qui compte vraiment, au moment de generer le document).
  donnees: z.unknown(),
});

brouillonsFormulaireRouter.put("/api/brouillons-formulaire/:typeAction", requireAuth, async (req, res) => {
  const parsed = brouillonSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const typeAction = req.params.typeAction;
  await prisma.brouillonFormulaire.upsert({
    where: { userId_typeAction: { userId: req.auth!.userId, typeAction } },
    create: { userId: req.auth!.userId, typeAction, donnees: parsed.data.donnees as object },
    update: { donnees: parsed.data.donnees as object },
  });
  return res.json({ ok: true });
});

brouillonsFormulaireRouter.delete("/api/brouillons-formulaire/:typeAction", requireAuth, async (req, res) => {
  await prisma.brouillonFormulaire.deleteMany({
    where: { userId: req.auth!.userId, typeAction: req.params.typeAction },
  });
  return res.json({ ok: true });
});
