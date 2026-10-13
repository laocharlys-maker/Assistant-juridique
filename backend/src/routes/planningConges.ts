import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { creerNotificationsMultiples } from "../services/notifications";
import { genererPlanning, type ParametresPlanning } from "../services/planningConges";
import { ensureTypesAbsenceParDefaut } from "../services/conges";

export const planningCongesRouter = Router();

planningCongesRouter.use(["/api/planning-conges", "/api/personnel"], requireAuth, requireModule("rh"));

// --- Souhaits de conges ---

const souhaitsSchema = z.object({
  annee: z.number().int(),
  souhaits: z
    .array(z.object({ rang: z.number().int().min(1).max(3), dateDebut: z.string().min(1), dateFin: z.string().min(1) }))
    .max(3),
});

async function trouverFicheAccessible(id: string, req: { auth?: { cabinetId: string; role: string; userId: string } }) {
  const fiche = await prisma.fichePersonnel.findFirst({ where: { id, cabinetId: req.auth!.cabinetId } });
  if (!fiche) return null;
  if (req.auth!.role !== "titulaire" && fiche.userId !== req.auth!.userId) return undefined;
  return fiche;
}

planningCongesRouter.get("/api/personnel/:id/souhaits-conges", async (req, res) => {
  const fiche = await trouverFicheAccessible(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Accès refusé à cette fiche." });

  const annee = Number(req.query.annee) || new Date().getFullYear();
  const souhaits = await prisma.souhaitConges.findMany({ where: { fichePersonnelId: fiche.id, annee }, orderBy: { rang: "asc" } });
  return res.json(souhaits);
});

// Remplace entierement les souhaits de l'annee (delete puis recreate) -
// meme pattern que l'affectation de courriers : une resoumission ne doit
// jamais laisser un ancien rang perime.
planningCongesRouter.post("/api/personnel/:id/souhaits-conges", async (req, res) => {
  const fiche = await trouverFicheAccessible(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Tu ne peux soumettre des souhaits que pour ta propre fiche." });

  const parsed = souhaitsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  for (const s of parsed.data.souhaits) {
    if (new Date(s.dateFin) < new Date(s.dateDebut)) {
      return res.status(400).json({ error: `Souhait n°${s.rang} : la date de fin doit être après la date de début.` });
    }
  }

  await prisma.$transaction([
    prisma.souhaitConges.deleteMany({ where: { fichePersonnelId: fiche.id, annee: parsed.data.annee } }),
    prisma.souhaitConges.createMany({
      data: parsed.data.souhaits.map((s) => ({
        fichePersonnelId: fiche.id,
        annee: parsed.data.annee,
        rang: s.rang,
        dateDebut: new Date(s.dateDebut),
        dateFin: new Date(s.dateFin),
      })),
    }),
  ]);

  const souhaits = await prisma.souhaitConges.findMany({ where: { fichePersonnelId: fiche.id, annee: parsed.data.annee }, orderBy: { rang: "asc" } });
  return res.status(201).json(souhaits);
});

// --- Planning ---

const SELECT_PLANNING = {
  id: true,
  cabinetId: true,
  annee: true,
  statut: true,
  parametres: true,
  genereLe: true,
  genereParId: true,
  lignes: {
    select: {
      id: true,
      fichePersonnelId: true,
      dateDebut: true,
      dateFin: true,
      nbJoursOuvres: true,
      origine: true,
      raison: true,
      fichePersonnel: { select: { id: true, nom: true, prenoms: true } },
    },
  },
} as const;

type PlanningAvecLignes = Prisma.PlanningCongesGetPayload<{ select: typeof SELECT_PLANNING }>;

// Les lignes "non_place" sont stockees avec une date sentinelle
// (new Date(0)) cote base - PlanningCongesLigne.dateDebut/dateFin sont des
// colonnes obligatoires. Jamais expose tel quel a l'API : remplace par
// null, pour que le front n'ait pas a connaitre ce detail d'implementation.
function nettoyerPlanning(planning: PlanningAvecLignes) {
  return {
    ...planning,
    lignes: planning.lignes.map((l) =>
      l.origine === "non_place" ? { ...l, dateDebut: null, dateFin: null } : l
    ),
  };
}

planningCongesRouter.get("/api/planning-conges/:annee", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut consulter le planning." });
  const annee = Number(req.params.annee);
  const planning = await prisma.planningConges.findUnique({
    where: { cabinetId_annee: { cabinetId: req.auth!.cabinetId, annee } },
    select: SELECT_PLANNING,
  });
  if (!planning) return res.status(404).json({ error: "Aucun planning pour cette année." });
  return res.json(nettoyerPlanning(planning));
});

const genererSchema = z.object({
  annee: z.number().int(),
  effectifMin: z.number().int().min(0),
  periodesBloquees: z.array(z.object({ debut: z.string().min(1), fin: z.string().min(1) })).default([]),
});

// Generation (ou regeneration si encore en brouillon) - jamais sur un
// planning deja valide (spec section 5.3 : "regenerable tant qu'il est en
// brouillon").
planningCongesRouter.post("/api/planning-conges", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut générer le planning." });
  const parsed = genererSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const existant = await prisma.planningConges.findUnique({
    where: { cabinetId_annee: { cabinetId: req.auth!.cabinetId, annee: parsed.data.annee } },
  });
  if (existant && existant.statut !== "brouillon") {
    return res.status(409).json({ error: "Ce planning est déjà validé - il n'est plus régénérable." });
  }

  const parametres: ParametresPlanning = { effectifMin: parsed.data.effectifMin, periodesBloquees: parsed.data.periodesBloquees };
  const parametresJson = parametres as unknown as Prisma.InputJsonValue;
  const resultats = await genererPlanning(req.auth!.cabinetId, parsed.data.annee, parametres);

  const planning = await prisma.$transaction(async (tx) => {
    if (existant) {
      await tx.planningCongesLigne.deleteMany({ where: { planningId: existant.id } });
      return tx.planningConges.update({
        where: { id: existant.id },
        data: { parametres: parametresJson, genereLe: new Date(), genereParId: req.auth!.userId },
      });
    }
    return tx.planningConges.create({
      data: { cabinetId: req.auth!.cabinetId, annee: parsed.data.annee, parametres: parametresJson, genereParId: req.auth!.userId },
    });
  });

  await prisma.planningCongesLigne.createMany({
    data: resultats.map((r) => ({
      planningId: planning.id,
      fichePersonnelId: r.fichePersonnelId,
      dateDebut: r.dateDebut ?? new Date(0),
      dateFin: r.dateFin ?? new Date(0),
      nbJoursOuvres: r.nbJoursOuvres,
      origine: r.origine,
      raison: r.raison,
    })),
  });

  console.log(
    `[rh-planning] planning ${parsed.data.annee} généré par ${req.auth!.userId} pour le cabinet ${req.auth!.cabinetId} (${resultats.filter((r) => r.origine === "non_place").length} non placé(s))`
  );

  const complet = await prisma.planningConges.findUniqueOrThrow({ where: { id: planning.id }, select: SELECT_PLANNING });
  return res.status(201).json(nettoyerPlanning(complet));
});

// Ajustement manuel d'une ligne (titulaire) - le planning doit encore etre
// en brouillon.
const ajusterLigneSchema = z.object({ dateDebut: z.string().min(1), dateFin: z.string().min(1) });

planningCongesRouter.patch("/api/planning-conges/lignes/:ligneId", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut ajuster le planning." });
  const parsed = ajusterLigneSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const ligne = await prisma.planningCongesLigne.findFirst({
    where: { id: req.params.ligneId, planning: { cabinetId: req.auth!.cabinetId } },
    include: { planning: true },
  });
  if (!ligne) return res.status(404).json({ error: "Ligne introuvable" });
  if (ligne.planning.statut !== "brouillon") return res.status(409).json({ error: "Ce planning est déjà validé." });

  const dateDebut = new Date(parsed.data.dateDebut);
  const dateFin = new Date(parsed.data.dateFin);
  if (dateFin < dateDebut) return res.status(400).json({ error: "La date de fin doit être après la date de début." });

  const misAJour = await prisma.planningCongesLigne.update({
    where: { id: ligne.id },
    data: { dateDebut, dateFin, origine: "manuel", raison: "Ajusté manuellement par le titulaire." },
  });
  return res.json(misAJour);
});

// Validation : chaque ligne PLACEE devient une DemandeAbsence approuvee,
// les employes concernes sont notifies (cloche + email via le mecanisme
// existant de decision - on cree directement au statut "approuvee", pas de
// second passage par la file de validation). Les lignes "non_place" ne
// creent aucune demande.
planningCongesRouter.post("/api/planning-conges/:id/valider", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut valider le planning." });

  const planning = await prisma.planningConges.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
    include: { lignes: { include: { fichePersonnel: { select: { id: true, userId: true } } } } },
  });
  if (!planning) return res.status(404).json({ error: "Planning introuvable" });
  if (planning.statut !== "brouillon") return res.status(409).json({ error: "Ce planning a déjà été validé." });

  // Garantit l'existence des types d'absence par defaut (dont "Congé
  // annuel", utilise ci-dessous) - un cabinet qui n'a jamais ouvert "Mes
  // congés" ni "Paramètres congés" avant de lancer un planning ne les a pas
  // encore (meme bootstrap paresseux que routes/conges.ts).
  await ensureTypesAbsenceParDefaut(req.auth!.cabinetId);
  const typeCongeAnnuel = await prisma.typeAbsence.findFirst({ where: { cabinetId: req.auth!.cabinetId, libelle: "Congé annuel" } });
  if (!typeCongeAnnuel) return res.status(400).json({ error: "Le type d'absence \"Congé annuel\" est introuvable." });

  const lignesPlacees = planning.lignes.filter((l) => l.origine !== "non_place");

  await prisma.$transaction([
    prisma.planningConges.update({ where: { id: planning.id }, data: { statut: "valide" } }),
    prisma.demandeAbsence.createMany({
      data: lignesPlacees.map((l) => ({
        cabinetId: req.auth!.cabinetId,
        fichePersonnelId: l.fichePersonnelId,
        typeAbsenceId: typeCongeAnnuel.id,
        dateDebut: l.dateDebut,
        dateFin: l.dateFin,
        nbJoursOuvres: l.nbJoursOuvres,
        statut: "approuvee",
        planningLigneId: l.id,
        decideParId: req.auth!.userId,
        dateDecision: new Date(),
      })),
    }),
  ]);

  console.log(`[rh-planning] planning ${planning.annee} validé par ${req.auth!.userId} pour le cabinet ${req.auth!.cabinetId}`);

  await creerNotificationsMultiples(
    lignesPlacees.map((l) => l.fichePersonnel.userId).filter((id): id is string => !!id),
    {
      cabinetId: req.auth!.cabinetId,
      type: "planning_conges_valide",
      titre: `Planning de congés ${planning.annee} validé`,
      message: "Tes congés de l'année ont été planifiés - consulte \"Mes congés\" pour le détail.",
      creeParId: req.auth!.userId,
    }
  );

  const complet = await prisma.planningConges.findUniqueOrThrow({ where: { id: planning.id }, select: SELECT_PLANNING });
  return res.json(nettoyerPlanning(complet));
});
