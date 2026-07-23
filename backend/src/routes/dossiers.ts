import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { getAccessibleAvocatIds } from "../services/access";

export const dossiersRouter = Router();

// Titulaire (admin) et avocat peuvent tous deux voir l'ensemble du cabinet
// (vue "cabinet" / acces direct par id) ; seul un collaborateur est
// restreint a son perimetre (getAccessibleAvocatIds).
function peutVoirTouLeCabinet(role: string | undefined): boolean {
  return role === "titulaire" || role === "avocat";
}

// Calcule l'etiquette de statut d'un dossier : "cloture" si marque comme
// tel, "echeance_proche" si un delai calcule pour ce dossier arrive dans
// les 7 jours, sinon "a_jour".
async function computeStatutTags(dossierIds: string[]): Promise<Map<string, string>> {
  const tags = new Map<string, string>();
  if (dossierIds.length === 0) return tags;

  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const prochesEcheances = await prisma.delaiCalcul.findMany({
    where: { dossierId: { in: dossierIds }, dateLimite: { gte: now, lte: in7Days } },
    select: { dossierId: true },
  });
  const idsAvecEcheance = new Set(prochesEcheances.map((d) => d.dossierId).filter(Boolean));

  for (const id of dossierIds) {
    tags.set(id, idsAvecEcheance.has(id) ? "echeance_proche" : "a_jour");
  }
  return tags;
}

dossiersRouter.get("/api/dossiers", requireAuth, async (req, res) => {
  const { auth } = req;
  // Un collaborateur ne peut jamais demander la vue "cabinet" complète ;
  // seuls le titulaire (admin) et un avocat le peuvent.
  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";

  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth!) : null;

  // "dossiers" (par defaut) = vrais dossiers clients actifs (non archives) ;
  // "archives" = dossiers clients archives automatiquement apres cloture ;
  // "recherches" = fiches de jurisprudence / recherche juridique / veille ;
  // "traductions" = fiches de traduction, isolees des autres recherches.
  const vueParam = req.query.vue;
  const vue =
    vueParam === "recherches"
      ? "recherches"
      : vueParam === "traductions"
        ? "traductions"
        : vueParam === "archives"
          ? "archives"
          : "dossiers";

  const dossiers = await prisma.dossier.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      estRecherche: vue === "recherches" || vue === "traductions",
      ...(vue === "dossiers" ? { archivedAt: null } : {}),
      ...(vue === "archives" ? { archivedAt: { not: null } } : {}),
      ...(vue === "traductions" ? { numeroDossier: { startsWith: "TRAD-" } } : {}),
      ...(vue === "recherches" ? { numeroDossier: { not: { startsWith: "TRAD-" } } } : {}),
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { actions: true } }, creePar: { select: { nom: true } } },
  });

  const tags = await computeStatutTags(dossiers.map((d) => d.id));
  const dossiersAvecTag = dossiers.map((d) => ({
    ...d,
    statutTag: d.statut === "cloture" ? "cloture" : tags.get(d.id) || "a_jour",
  }));

  return res.json({ scope, vue, dossiers: dossiersAvecTag });
});

dossiersRouter.get("/api/dossiers/:id", requireAuth, async (req, res) => {
  const { auth } = req;

  // Le titulaire (admin) et un avocat voient tout le cabinet ; un
  // collaborateur seulement les dossiers des avocats auxquels il a accès.
  const accessibleAvocatIds = peutVoirTouLeCabinet(auth!.role)
    ? null
    : await getAccessibleAvocatIds(auth!);

  const dossier = await prisma.dossier.findFirst({
    where: {
      id: req.params.id,
      cabinetId: auth!.cabinetId,
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
    include: {
      creePar: { select: { nom: true } },
      actions: {
        orderBy: { createdAt: "desc" },
        include: { creePar: { select: { nom: true } } },
      },
    },
  });

  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  const tags = await computeStatutTags([dossier.id]);
  const statutTag = dossier.statut === "cloture" ? "cloture" : tags.get(dossier.id) || "a_jour";

  return res.json({ ...dossier, statutTag });
});

const updateStatutSchema = z.object({
  statut: z.enum(["actif", "cloture"]),
});

dossiersRouter.patch("/api/dossiers/:id", requireAuth, async (req, res) => {
  const { auth } = req;
  const parsed = updateStatutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  const accessibleAvocatIds = peutVoirTouLeCabinet(auth!.role)
    ? null
    : await getAccessibleAvocatIds(auth!);

  const dossier = await prisma.dossier.findFirst({
    where: {
      id: req.params.id,
      cabinetId: auth!.cabinetId,
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
  });
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  await prisma.dossier.update({
    where: { id: dossier.id },
    data:
      parsed.data.statut === "cloture"
        ? { statut: "cloture", dateCloture: new Date() }
        : { statut: "actif", dateCloture: null, archivedAt: null },
  });
  return res.json({ ok: true });
});
