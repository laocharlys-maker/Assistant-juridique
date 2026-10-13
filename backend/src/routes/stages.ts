import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { logAuditPersonnel } from "../services/audit";
import { creerNotification } from "../services/notifications";

export const stagesRouter = Router();

stagesRouter.use(["/api/stages", "/api/personnel"], requireAuth, requireModule("rh"));

const SELECT_STAGE = {
  id: true,
  cabinetId: true,
  fichePersonnelId: true,
  responsableId: true,
  dateDebut: true,
  dateFinPrevue: true,
  statut: true,
  objet: true,
  responsable: { select: { id: true, nom: true } },
  fichePersonnel: { select: { id: true, nom: true, prenoms: true, userId: true } },
  prolongations: { orderBy: { createdAt: "asc" as const } },
} as const;

async function peutGererStage(stage: { responsableId: string }, auth: { role: string; userId: string }): Promise<boolean> {
  return auth.role === "titulaire" || stage.responsableId === auth.userId;
}

// Liste des stages en cours - titulaire : tous ceux du cabinet. Autre
// utilisateur : uniquement ceux dont il/elle est responsable (ecran "Suivi
// des stages").
stagesRouter.get("/api/stages", async (req, res) => {
  const { auth } = req;
  const stages = await prisma.stage.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      statut: "en_cours",
      ...(auth!.role === "titulaire" ? {} : { responsableId: auth!.userId }),
    },
    select: SELECT_STAGE,
    orderBy: { dateFinPrevue: "asc" },
  });
  return res.json(stages);
});

async function trouverFicheAccessiblePourStage(
  fichePersonnelId: string,
  req: { auth?: { cabinetId: string; role: string; userId: string } }
) {
  const fiche = await prisma.fichePersonnel.findFirst({
    where: { id: fichePersonnelId, cabinetId: req.auth!.cabinetId },
  });
  if (!fiche) return null;
  if (req.auth!.role === "titulaire") return fiche;
  if (fiche.userId === req.auth!.userId) return fiche;
  // Le responsable d'au moins un stage de cette fiche peut aussi consulter.
  const estResponsable = await prisma.stage.findFirst({
    where: { fichePersonnelId, responsableId: req.auth!.userId },
  });
  return estResponsable ? fiche : undefined;
}

stagesRouter.get("/api/personnel/:id/stages", async (req, res) => {
  const fiche = await trouverFicheAccessiblePourStage(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Accès refusé à cette fiche." });

  const stages = await prisma.stage.findMany({
    where: { fichePersonnelId: req.params.id },
    select: SELECT_STAGE,
    orderBy: { dateDebut: "desc" },
  });
  return res.json(stages);
});

const creerStageSchema = z.object({
  responsableId: z.string().uuid(),
  dateDebut: z.string().min(1),
  dateFinPrevue: z.string().min(1),
  objet: z.string().trim().optional(),
});

// Creation reservee au titulaire - meme perimetre que la creation d'une
// fiche personnel (docs/rh/00-audit.md, decision du 13/10/2026).
stagesRouter.post("/api/personnel/:id/stages", async (req, res) => {
  if (req.auth!.role !== "titulaire") {
    return res.status(403).json({ error: "Seul le titulaire peut créer un stage." });
  }
  const parsed = creerStageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const fiche = await prisma.fichePersonnel.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!fiche) return res.status(404).json({ error: "Fiche introuvable" });

  // Contrainte explicite de la spec : le responsable DOIT avoir un compte
  // Aurore pour pouvoir etre notifie (voir schema.prisma, Stage.responsableId).
  const responsable = await prisma.user.findFirst({
    where: { id: parsed.data.responsableId, cabinetId: req.auth!.cabinetId, actif: true },
  });
  if (!responsable) return res.status(404).json({ error: "Responsable introuvable (doit avoir un compte Aurore actif)." });

  const dateDebut = new Date(parsed.data.dateDebut);
  const dateFinPrevue = new Date(parsed.data.dateFinPrevue);
  if (dateFinPrevue <= dateDebut) {
    return res.status(400).json({ error: "La date de fin prévue doit être après la date de début." });
  }

  const stage = await prisma.stage.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      fichePersonnelId: fiche.id,
      responsableId: responsable.id,
      dateDebut,
      dateFinPrevue,
      objet: parsed.data.objet || null,
    },
    select: SELECT_STAGE,
  });

  await logAuditPersonnel(fiche.id, "stage_cree", "succes", `Stage créé par ${req.auth!.userId}, responsable ${responsable.id}`);
  return res.status(201).json(stage);
});

const statutSchema = z.object({ statut: z.enum(["termine", "interrompu"]) });

// Cloture (titulaire OU le responsable du stage) - arrete definitivement
// les rappels (statut hors "en_cours", voir runRappelsStage).
stagesRouter.patch("/api/stages/:id/statut", async (req, res) => {
  const parsed = statutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const stage = await prisma.stage.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } });
  if (!stage) return res.status(404).json({ error: "Stage introuvable" });
  if (!(await peutGererStage(stage, req.auth!))) {
    return res.status(403).json({ error: "Seul le titulaire ou le responsable de ce stage peut le clôturer." });
  }

  const misAJour = await prisma.stage.update({
    where: { id: stage.id },
    data: { statut: parsed.data.statut },
    select: SELECT_STAGE,
  });

  await logAuditPersonnel(stage.fichePersonnelId, "stage_cloture", "succes", `Statut → ${parsed.data.statut} par ${req.auth!.userId}`);
  return res.json(misAJour);
});

const prolongerSchema = z.object({
  nouvelleDateFin: z.string().min(1),
  motif: z.string().trim().optional(),
});

// Prolongation (titulaire OU le responsable) : cree une ligne d'historique,
// recalcule l'echeance, et REINITIALISE LES RAPPELS FUTURS (supprime les
// StageRappelEnvoye existants - le prochain passage du job les recalcule
// depuis zero par rapport a la nouvelle date, voir spec section 5.2).
stagesRouter.post("/api/stages/:id/prolonger", async (req, res) => {
  const parsed = prolongerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const stage = await prisma.stage.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } });
  if (!stage) return res.status(404).json({ error: "Stage introuvable" });
  if (!(await peutGererStage(stage, req.auth!))) {
    return res.status(403).json({ error: "Seul le titulaire ou le responsable de ce stage peut le prolonger." });
  }

  const nouvelleDateFin = new Date(parsed.data.nouvelleDateFin);
  if (nouvelleDateFin <= stage.dateFinPrevue) {
    return res.status(400).json({ error: "La nouvelle date de fin doit être après l'échéance actuelle." });
  }

  const [, , misAJour] = await prisma.$transaction([
    prisma.stageProlongation.create({
      data: {
        stageId: stage.id,
        ancienneDateFin: stage.dateFinPrevue,
        nouvelleDateFin,
        motif: parsed.data.motif || null,
        decideParId: req.auth!.userId,
      },
    }),
    prisma.stageRappelEnvoye.deleteMany({ where: { stageId: stage.id } }),
    prisma.stage.update({
      where: { id: stage.id },
      data: { dateFinPrevue: nouvelleDateFin, statut: "en_cours" },
      select: SELECT_STAGE,
    }),
  ]);

  await logAuditPersonnel(
    stage.fichePersonnelId,
    "stage_prolonge",
    "succes",
    `Prolongé jusqu'au ${nouvelleDateFin.toISOString().slice(0, 10)} par ${req.auth!.userId}`
  );

  // Le responsable est informe du changement d'echeance (pas seulement les
  // futurs rappels automatiques).
  await creerNotification({
    cabinetId: stage.cabinetId,
    destinataireId: stage.responsableId,
    type: "stage_prolonge",
    titre: "Stage prolongé",
    message: `Nouvelle échéance : ${nouvelleDateFin.toLocaleDateString("fr-FR")}.`,
    lienUrl: `/personnel-fiche.html?id=${stage.fichePersonnelId}`,
    creeParId: req.auth!.userId,
  });

  return res.json(misAJour);
});
