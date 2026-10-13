import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { logAuditPersonnel } from "../services/audit";
import { creerNotification } from "../services/notifications";
import { ensureTypesAbsenceParDefaut, calculerJoursOuvres, joursPris } from "../services/conges";

export const congesRouter = Router();

congesRouter.use(["/api/types-absence", "/api/jours-feries", "/api/conges", "/api/personnel", "/api/demandes-absence"], requireAuth, requireModule("rh"));

// --- Types d'absence ---

congesRouter.get("/api/types-absence", async (req, res) => {
  await ensureTypesAbsenceParDefaut(req.auth!.cabinetId);
  const types = await prisma.typeAbsence.findMany({ where: { cabinetId: req.auth!.cabinetId, actif: true } });
  return res.json(types);
});

const typeAbsenceSchema = z.object({
  libelle: z.string().trim().min(1),
  decompteSolde: z.boolean(),
  remunere: z.boolean(),
  justificatifRequis: z.boolean(),
});

congesRouter.post("/api/types-absence", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut gérer les types d'absence." });
  const parsed = typeAbsenceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const type = await prisma.typeAbsence.create({ data: { cabinetId: req.auth!.cabinetId, ...parsed.data } });
  return res.status(201).json(type);
});

congesRouter.patch("/api/types-absence/:id", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut gérer les types d'absence." });
  const parsed = typeAbsenceSchema.partial().extend({ actif: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const existant = await prisma.typeAbsence.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } });
  if (!existant) return res.status(404).json({ error: "Type d'absence introuvable" });

  const type = await prisma.typeAbsence.update({ where: { id: existant.id }, data: parsed.data });
  return res.json(type);
});

// --- Jours feries ---

congesRouter.get("/api/jours-feries", async (req, res) => {
  const jours = await prisma.jourFerie.findMany({ where: { cabinetId: req.auth!.cabinetId }, orderBy: { date: "asc" } });
  return res.json(jours);
});

const jourFerieSchema = z.object({
  date: z.string().min(1),
  libelle: z.string().trim().min(1),
  recurrentChaqueAnnee: z.boolean().default(false),
});

congesRouter.post("/api/jours-feries", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut gérer les jours fériés." });
  const parsed = jourFerieSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const jour = await prisma.jourFerie.create({
    data: { cabinetId: req.auth!.cabinetId, date: new Date(parsed.data.date), libelle: parsed.data.libelle, recurrentChaqueAnnee: parsed.data.recurrentChaqueAnnee },
  });
  return res.status(201).json(jour);
});

congesRouter.delete("/api/jours-feries/:id", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut gérer les jours fériés." });
  const existant = await prisma.jourFerie.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } });
  if (!existant) return res.status(404).json({ error: "Jour férié introuvable" });
  await prisma.jourFerie.delete({ where: { id: existant.id } });
  return res.json({ ok: true });
});

// --- Solde de conges ---

async function trouverFicheAccessible(id: string, req: { auth?: { cabinetId: string; role: string; userId: string } }) {
  const fiche = await prisma.fichePersonnel.findFirst({ where: { id, cabinetId: req.auth!.cabinetId } });
  if (!fiche) return null;
  if (req.auth!.role !== "titulaire" && fiche.userId !== req.auth!.userId) return undefined;
  return fiche;
}

congesRouter.get("/api/personnel/:id/solde-conges", async (req, res) => {
  const fiche = await trouverFicheAccessible(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Accès refusé à cette fiche." });

  const annee = Number(req.query.annee) || new Date().getFullYear();
  const solde = await prisma.soldeConges.findUnique({ where: { fichePersonnelId_annee: { fichePersonnelId: fiche.id, annee } } });
  const pris = await joursPris(fiche.id, annee);
  return res.json({
    annee,
    droitJours: solde?.droitJours ?? 0,
    reportJours: solde?.reportJours ?? 0,
    joursPris: pris,
    soldeRestant: (solde?.droitJours ?? 0) + (solde?.reportJours ?? 0) - pris,
  });
});

const soldeSchema = z.object({ annee: z.number().int(), droitJours: z.number().min(0), reportJours: z.number().min(0) });

congesRouter.patch("/api/personnel/:id/solde-conges", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut fixer un solde de congés." });
  const parsed = soldeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const fiche = await prisma.fichePersonnel.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } });
  if (!fiche) return res.status(404).json({ error: "Fiche introuvable" });

  const solde = await prisma.soldeConges.upsert({
    where: { fichePersonnelId_annee: { fichePersonnelId: fiche.id, annee: parsed.data.annee } },
    update: { droitJours: parsed.data.droitJours, reportJours: parsed.data.reportJours },
    create: { fichePersonnelId: fiche.id, annee: parsed.data.annee, droitJours: parsed.data.droitJours, reportJours: parsed.data.reportJours },
  });
  await logAuditPersonnel(fiche.id, "solde_conges_modifie", "succes", `Fixé par ${req.auth!.userId} pour ${parsed.data.annee}`);
  return res.json(solde);
});

// --- Demandes d'absence ---

const SELECT_DEMANDE = {
  id: true,
  fichePersonnelId: true,
  typeAbsenceId: true,
  dateDebut: true,
  dateFin: true,
  demiJourneeDebut: true,
  demiJourneeFin: true,
  nbJoursOuvres: true,
  statut: true,
  decideParId: true,
  dateDecision: true,
  commentaireDecision: true,
  motif: true,
  createdAt: true,
  typeAbsence: { select: { id: true, libelle: true, decompteSolde: true } },
  fichePersonnel: { select: { id: true, nom: true, prenoms: true } },
} as const;

congesRouter.get("/api/personnel/:id/demandes-absence", async (req, res) => {
  const fiche = await trouverFicheAccessible(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Accès refusé à cette fiche." });

  const demandes = await prisma.demandeAbsence.findMany({
    where: { fichePersonnelId: fiche.id },
    select: SELECT_DEMANDE,
    orderBy: { dateDebut: "desc" },
  });
  return res.json(demandes);
});

const creerDemandeSchema = z.object({
  typeAbsenceId: z.string().uuid(),
  dateDebut: z.string().min(1),
  dateFin: z.string().min(1),
  demiJourneeDebut: z.boolean().default(false),
  demiJourneeFin: z.boolean().default(false),
  motif: z.string().trim().optional(),
});

// Creation : le titulaire au nom de n'importe quel employe, ou un
// avocat/collaborateur pour SA PROPRE fiche uniquement (meme perimetre que
// trouverFicheAccessible).
congesRouter.post("/api/personnel/:id/demandes-absence", async (req, res) => {
  const fiche = await trouverFicheAccessible(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Tu ne peux poser une demande que pour ta propre fiche." });

  const parsed = creerDemandeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const typeAbsence = await prisma.typeAbsence.findFirst({ where: { id: parsed.data.typeAbsenceId, cabinetId: req.auth!.cabinetId, actif: true } });
  if (!typeAbsence) return res.status(404).json({ error: "Type d'absence introuvable" });

  const dateDebut = new Date(parsed.data.dateDebut);
  const dateFin = new Date(parsed.data.dateFin);
  if (dateFin < dateDebut) return res.status(400).json({ error: "La date de fin doit être après la date de début." });

  const [cabinet, joursFeries] = await Promise.all([
    prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId }, select: { rhSamediOuvre: true } }),
    prisma.jourFerie.findMany({ where: { cabinetId: req.auth!.cabinetId }, select: { date: true, recurrentChaqueAnnee: true } }),
  ]);
  const nbJoursOuvres = calculerJoursOuvres(dateDebut, dateFin, {
    demiJourneeDebut: parsed.data.demiJourneeDebut,
    demiJourneeFin: parsed.data.demiJourneeFin,
    samediOuvre: cabinet?.rhSamediOuvre ?? false,
    joursFeries,
  });
  if (nbJoursOuvres <= 0) {
    return res.status(400).json({ error: "Cette période ne contient aucun jour ouvré." });
  }

  const demande = await prisma.demandeAbsence.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      fichePersonnelId: fiche.id,
      typeAbsenceId: typeAbsence.id,
      dateDebut,
      dateFin,
      demiJourneeDebut: parsed.data.demiJourneeDebut,
      demiJourneeFin: parsed.data.demiJourneeFin,
      nbJoursOuvres,
      motif: parsed.data.motif || null,
    },
    select: SELECT_DEMANDE,
  });

  await logAuditPersonnel(fiche.id, "demande_absence_creee", "succes", `Créée par ${req.auth!.userId}`);
  return res.status(201).json(demande);
});

// File d'attente de validation - titulaire uniquement (pas de delegation
// possible sans Lot 9, meme decision que personnel/stages - voir
// docs/rh/00-audit.md).
congesRouter.get("/api/demandes-absence", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut consulter la file de validation." });
  const statut = typeof req.query.statut === "string" ? req.query.statut : "en_attente";
  const demandes = await prisma.demandeAbsence.findMany({
    where: { cabinetId: req.auth!.cabinetId, statut },
    select: SELECT_DEMANDE,
    orderBy: { createdAt: "asc" },
  });
  return res.json(demandes);
});

const decisionSchema = z.object({ decision: z.enum(["approuvee", "refusee"]), commentaire: z.string().trim().optional() });

congesRouter.patch("/api/demandes-absence/:id/decision", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut valider ou refuser une demande." });
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const demande = await prisma.demandeAbsence.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } });
  if (!demande) return res.status(404).json({ error: "Demande introuvable" });
  if (demande.statut !== "en_attente") return res.status(409).json({ error: "Cette demande a déjà été traitée." });

  const misAJour = await prisma.demandeAbsence.update({
    where: { id: demande.id },
    data: {
      statut: parsed.data.decision,
      decideParId: req.auth!.userId,
      dateDecision: new Date(),
      commentaireDecision: parsed.data.commentaire || null,
    },
    select: SELECT_DEMANDE,
  });

  await logAuditPersonnel(demande.fichePersonnelId, "demande_absence_decidee", "succes", `${parsed.data.decision} par ${req.auth!.userId}`);

  const fiche = await prisma.fichePersonnel.findUnique({ where: { id: demande.fichePersonnelId }, select: { userId: true } });
  if (fiche?.userId) {
    await creerNotification({
      cabinetId: req.auth!.cabinetId,
      destinataireId: fiche.userId,
      type: "demande_absence_decidee",
      titre: parsed.data.decision === "approuvee" ? "Votre demande de congé a été approuvée" : "Votre demande de congé a été refusée",
      message: parsed.data.commentaire,
      creeParId: req.auth!.userId,
    });
  }

  return res.json(misAJour);
});

// Annulation : titulaire a tout moment, ou l'employe lui-meme tant que la
// demande est encore en attente.
congesRouter.post("/api/demandes-absence/:id/annuler", async (req, res) => {
  const demande = await prisma.demandeAbsence.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
    include: { fichePersonnel: { select: { userId: true } } },
  });
  if (!demande) return res.status(404).json({ error: "Demande introuvable" });

  const estProprietaire = demande.fichePersonnel.userId === req.auth!.userId;
  if (req.auth!.role !== "titulaire" && !(estProprietaire && demande.statut === "en_attente")) {
    return res.status(403).json({ error: "Tu ne peux annuler que ta propre demande, tant qu'elle est en attente." });
  }

  const misAJour = await prisma.demandeAbsence.update({ where: { id: demande.id }, data: { statut: "annulee" }, select: SELECT_DEMANDE });
  await logAuditPersonnel(demande.fichePersonnelId, "demande_absence_annulee", "succes", `Annulée par ${req.auth!.userId}`);
  return res.json(misAJour);
});

// --- Calendrier d'equipe : "absent" uniquement, jamais le motif ni meme le
// type d'absence (contrainte explicite de la spec section 3). ---

congesRouter.get("/api/conges/calendrier-equipe", async (req, res) => {
  const debut = typeof req.query.debut === "string" ? new Date(req.query.debut) : new Date();
  const fin = typeof req.query.fin === "string" ? new Date(req.query.fin) : new Date(debut.getTime() + 30 * 86400000);

  const demandes = await prisma.demandeAbsence.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      statut: "approuvee",
      dateDebut: { lte: fin },
      dateFin: { gte: debut },
    },
    select: {
      dateDebut: true,
      dateFin: true,
      fichePersonnel: { select: { id: true, nom: true, prenoms: true } },
    },
  });

  return res.json(
    demandes.map((d) => ({
      fichePersonnelId: d.fichePersonnel.id,
      nom: `${d.fichePersonnel.nom}${d.fichePersonnel.prenoms ? " " + d.fichePersonnel.prenoms : ""}`,
      dateDebut: d.dateDebut,
      dateFin: d.dateFin,
      libelle: "Absent",
    }))
  );
});
