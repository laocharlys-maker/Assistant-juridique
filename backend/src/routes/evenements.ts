import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { getAccessibleAvocatIds } from "../services/access";
import { enqueuerSyncEvenement, enqueuerSuppressionEvenement } from "../services/calendrierSync/syncQueue";

export const evenementsRouter = Router();

function peutVoirTouLeCabinet(role: string | undefined): boolean {
  return role === "titulaire" || role === "avocat";
}

// Exporte : reutilise tel quel par routes/roleAudiences.ts (filtre par
// types du "Role de la semaine") - source unique de la liste des types,
// jamais une copie qui pourrait diverger.
export const TYPES_EVENEMENT = ["audience", "rdv", "appel", "tache", "echeance_procedure", "autre"] as const;
// Types creables/modifiables manuellement via ces routes - "audience" et
// "echeance_procedure" restent exclusivement generes par evenementSync.ts
// (RoleAudience/DelaiCalcul), pour ne jamais diverger silencieusement de
// leur source (voir README-LOT12A.md).
const TYPES_MANUELS = ["rdv", "appel", "tache", "autre"] as const;

const INCLUDE_STANDARD = {
  dossier: { select: { id: true, numeroDossier: true, nomAffaire: true } },
  createdBy: { select: { nom: true } },
  assignes: { include: { user: { select: { id: true, nom: true } } } },
} as const;

function calculerPeriodeParDefaut(req: { query: { debut?: unknown; fin?: unknown } }): { debut: Date; fin: Date } {
  const debutParam = typeof req.query.debut === "string" ? new Date(req.query.debut) : null;
  const finParam = typeof req.query.fin === "string" ? new Date(req.query.fin) : null;
  if (debutParam && !Number.isNaN(debutParam.getTime()) && finParam && !Number.isNaN(finParam.getTime())) {
    return { debut: debutParam, fin: finParam };
  }
  // Filtre par defaut : mois en cours.
  const now = new Date();
  const debut = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const fin = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { debut, fin };
}

// Vue calendrier unifiee (mois/semaine/jour/liste, cote frontend - cette
// route reste agnostique de la "vue", elle filtre juste sur [debut, fin[) -
// toujours limitee a la periode demandee, jamais un chargement complet du
// cabinet (voir README-LOT12A.md, "performance").
evenementsRouter.get("/api/evenements", requireAuth, async (req, res) => {
  const { auth } = req;

  // Cas particulier "Agenda du dossier" : tous les evenements lies a un
  // dossier precis, sans limite de periode ni filtrage par acces (si tu
  // peux ouvrir la fiche du dossier - deja verifie par GET /api/dossiers/:id -
  // tu peux voir son agenda complet, meme regle que le reste de la fiche).
  const dossierIdParam = typeof req.query.dossierId === "string" ? req.query.dossierId : undefined;
  if (dossierIdParam) {
    const dossier = await prisma.dossier.findFirst({ where: { id: dossierIdParam, cabinetId: auth!.cabinetId } });
    if (!dossier) {
      return res.status(404).json({ error: "Dossier introuvable" });
    }
    const evenements = await prisma.evenement.findMany({
      where: { dossierId: dossierIdParam },
      include: INCLUDE_STANDARD,
      orderBy: { dateDebut: "asc" },
    });
    return res.json({ evenements });
  }

  const { debut, fin } = calculerPeriodeParDefaut(req);

  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";
  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth!) : null;

  const typeParam =
    typeof req.query.type === "string" && (TYPES_EVENEMENT as readonly string[]).includes(req.query.type)
      ? (req.query.type as (typeof TYPES_EVENEMENT)[number])
      : undefined;
  const assigneParam = typeof req.query.assigne === "string" ? req.query.assigne : undefined;

  // Chevauchement avec [debut, fin[ : demarre avant la fin de periode, et
  // (a une date de fin qui tombe apres le debut de periode) OU (n'a pas de
  // date de fin et demarre apres le debut de periode).
  const dateCondition = {
    OR: [{ dateFin: { gte: debut } }, { dateFin: null, dateDebut: { gte: debut } }],
  };

  const accessCondition = accessibleAvocatIds
    ? {
        OR: [
          { dossier: { createdBy: { in: accessibleAvocatIds } } },
          { dossierId: null, createdById: { in: [...accessibleAvocatIds, auth!.userId] } },
          { assignes: { some: { userId: auth!.userId } } },
        ],
      }
    : {};

  const evenements = await prisma.evenement.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      dateDebut: { lt: fin },
      ...(typeParam ? { type: typeParam } : {}),
      ...(assigneParam ? { assignes: { some: { userId: assigneParam } } } : {}),
      AND: [dateCondition, accessCondition],
    },
    include: INCLUDE_STANDARD,
    orderBy: { dateDebut: "asc" },
  });

  return res.json({ scope, debut: debut.toISOString(), fin: fin.toISOString(), evenements });
});

const createSchema = z.object({
  type: z.enum(TYPES_MANUELS),
  titre: z.string().min(1),
  description: z.string().optional(),
  dateDebut: z.string().min(1),
  dateFin: z.string().optional(),
  touteLaJournee: z.boolean().optional().default(false),
  lieu: z.string().optional(),
  dossierId: z.string().uuid().optional(),
  assignes: z.array(z.string().uuid()).optional().default([]),
});

async function assignesValidesPourCabinet(assignes: string[], cabinetId: string): Promise<string[]> {
  if (assignes.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: assignes }, cabinetId },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

// Creation manuelle - RDV, appel, tache ou autre. Les types "audience" et
// "echeance_procedure" sont rejetes ici (validation Zod) : ils ne peuvent
// exister que via evenementSync.ts, depuis leur enregistrement source.
evenementsRouter.post("/api/evenements", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const dateDebut = new Date(parsed.data.dateDebut);
  if (Number.isNaN(dateDebut.getTime())) {
    return res.status(400).json({ error: "Date de début invalide" });
  }
  let dateFin: Date | undefined;
  if (parsed.data.dateFin) {
    dateFin = new Date(parsed.data.dateFin);
    if (Number.isNaN(dateFin.getTime())) {
      return res.status(400).json({ error: "Date de fin invalide" });
    }
  }

  let dossier = null;
  if (parsed.data.dossierId) {
    dossier = await prisma.dossier.findFirst({
      where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
    });
    if (!dossier) {
      return res.status(404).json({ error: "Dossier introuvable" });
    }
  }

  const assignesValides = await assignesValidesPourCabinet(parsed.data.assignes, req.auth!.cabinetId);

  const evenement = await prisma.evenement.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: dossier?.id,
      type: parsed.data.type,
      source: "manuel",
      titre: parsed.data.titre,
      description: parsed.data.description,
      dateDebut,
      dateFin,
      touteLaJournee: parsed.data.touteLaJournee,
      lieu: parsed.data.lieu,
      createdById: req.auth!.userId,
      assignes: { create: assignesValides.map((userId) => ({ userId })) },
    },
    include: INCLUDE_STANDARD,
  });

  // Lot 12b : hook additif - met en file la synchro vers les agendas
  // externes concernes (jamais attendu par la reponse HTTP : n'effectue
  // que des ecritures DB, aucun appel reseau ici - voir syncQueue.ts).
  await enqueuerSyncEvenement(evenement.id);

  return res.status(201).json(evenement);
});

const updateSchema = z.object({
  titre: z.string().min(1).optional(),
  description: z.string().optional(),
  dateDebut: z.string().optional(),
  dateFin: z.string().nullable().optional(),
  touteLaJournee: z.boolean().optional(),
  lieu: z.string().optional(),
  dossierId: z.string().uuid().nullable().optional(),
  assignes: z.array(z.string().uuid()).optional(),
});

evenementsRouter.patch("/api/evenements/:id", requireAuth, async (req, res) => {
  const existing = await prisma.evenement.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!existing) {
    return res.status(404).json({ error: "Événement introuvable" });
  }
  if (existing.source !== "manuel") {
    return res.status(409).json({
      error: "Cet événement est généré automatiquement : modifie-le depuis son origine (rôle de la semaine ou délais).",
    });
  }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  let dossierId: string | null | undefined;
  if (parsed.data.dossierId !== undefined) {
    if (parsed.data.dossierId === null) {
      dossierId = null;
    } else {
      const dossier = await prisma.dossier.findFirst({
        where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
      });
      if (!dossier) {
        return res.status(404).json({ error: "Dossier introuvable" });
      }
      dossierId = dossier.id;
    }
  }

  let dateDebut: Date | undefined;
  if (parsed.data.dateDebut !== undefined) {
    dateDebut = new Date(parsed.data.dateDebut);
    if (Number.isNaN(dateDebut.getTime())) {
      return res.status(400).json({ error: "Date de début invalide" });
    }
  }
  let dateFin: Date | null | undefined;
  if (parsed.data.dateFin !== undefined) {
    dateFin = parsed.data.dateFin === null ? null : new Date(parsed.data.dateFin);
    if (dateFin && Number.isNaN(dateFin.getTime())) {
      return res.status(400).json({ error: "Date de fin invalide" });
    }
  }

  const evenement = await prisma.$transaction(async (tx) => {
    if (parsed.data.assignes !== undefined) {
      const assignesValides = await assignesValidesPourCabinet(parsed.data.assignes, req.auth!.cabinetId);
      await tx.evenementAssigne.deleteMany({ where: { evenementId: existing.id } });
      if (assignesValides.length > 0) {
        await tx.evenementAssigne.createMany({
          data: assignesValides.map((userId) => ({ evenementId: existing.id, userId })),
        });
      }
    }

    return tx.evenement.update({
      where: { id: existing.id },
      data: {
        titre: parsed.data.titre,
        description: parsed.data.description,
        dateDebut,
        dateFin,
        touteLaJournee: parsed.data.touteLaJournee,
        lieu: parsed.data.lieu,
        ...(dossierId !== undefined ? { dossierId } : {}),
      },
      include: INCLUDE_STANDARD,
    });
  });

  // Lot 12b : re-synchronise (le contenu a pu changer) - meme hook que la
  // creation, toujours non bloquant.
  await enqueuerSyncEvenement(evenement.id);

  return res.json(evenement);
});

evenementsRouter.delete("/api/evenements/:id", requireAuth, async (req, res) => {
  const existing = await prisma.evenement.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!existing) {
    return res.status(404).json({ error: "Événement introuvable" });
  }
  if (existing.source !== "manuel") {
    return res.status(409).json({
      error: "Cet événement est généré automatiquement : supprime-le depuis son origine (rôle de la semaine ou délais).",
    });
  }

  // Lot 12b : met en file la suppression externe AVANT de supprimer
  // l'Evenement Aurore (pendant que les lignes EvenementSyncExterne sont
  // encore rattachees) - voir syncQueue.ts.
  await enqueuerSuppressionEvenement(existing.id);

  await prisma.evenement.delete({ where: { id: existing.id } });
  return res.json({ ok: true });
});
