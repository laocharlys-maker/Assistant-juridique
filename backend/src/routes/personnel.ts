import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { logAuditPersonnel } from "../services/audit";

export const personnelRouter = Router();

personnelRouter.use("/api/personnel", requireAuth, requireModule("rh"));

// Valeurs V1 - chaines libres cote schema (voir schema.prisma, model
// FichePersonnel), validees ici pour pouvoir en ajouter une sans migration
// si un cabinet le demande (meme logique que Dossier.statut ailleurs).
const CATEGORIES = ["avocat", "collaborateur", "stagiaire", "secretariat", "comptable", "autre"] as const;
const TYPES_CONTRAT = ["cdi", "cdd", "stage", "liberal", "autre"] as const;
const MODES_PAIEMENT = ["virement", "especes", "mobile_money"] as const;

const SELECT_LISTE = {
  id: true,
  nom: true,
  prenoms: true,
  categorie: true,
  typeContrat: true,
  dateEntree: true,
  statut: true,
  userId: true,
} as const;

const SELECT_FICHE = {
  ...SELECT_LISTE,
  fonction: true,
  dateSortie: true,
  telephone: true,
  email: true,
  contactUrgence: true,
  modePaiement: true,
  coordonneesPaiement: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, nom: true, email: true, role: true } },
} as const;

// Titulaire : tout le personnel actif du cabinet (ou tous si ?statut=tous).
// Avocat/collaborateur : uniquement SA propre fiche, si elle existe (Lot 9
// non livre - voir docs/rh/00-audit.md, decision du 13/10/2026 : pas de
// delegation individuelle possible en V1, le role seul decide).
personnelRouter.get("/api/personnel", async (req, res) => {
  const { auth } = req;
  if (auth!.role === "titulaire") {
    const voirTous = req.query.statut === "tous";
    const fiches = await prisma.fichePersonnel.findMany({
      where: { cabinetId: auth!.cabinetId, ...(voirTous ? {} : { statut: "actif" }) },
      select: SELECT_LISTE,
      orderBy: { nom: "asc" },
    });
    return res.json(fiches);
  }

  const maFiche = await prisma.fichePersonnel.findFirst({
    where: { cabinetId: auth!.cabinetId, userId: auth!.userId },
    select: SELECT_LISTE,
  });
  return res.json(maFiche ? [maFiche] : []);
});

// Annuaire minimal des comptes Aurore PAS ENCORE rattaches a une fiche
// personnel - pour le selecteur optionnel "Compte Aurore existant" du
// formulaire de creation/edition. DOIT rester declare AVANT GET
// "/api/personnel/:id" ci-dessous, sinon Express traiterait
// "comptes-disponibles" comme une valeur de :id (routes matchees dans
// l'ordre de declaration).
personnelRouter.get("/api/personnel/comptes-disponibles", async (req, res) => {
  const comptes = await prisma.user.findMany({
    where: { cabinetId: req.auth!.cabinetId, actif: true, fichePersonnel: null },
    select: { id: true, nom: true, email: true, role: true },
    orderBy: { nom: "asc" },
  });
  return res.json(comptes);
});

async function trouverFicheAccessible(id: string, req: { auth?: { cabinetId: string; role: string; userId: string } }) {
  const fiche = await prisma.fichePersonnel.findFirst({
    where: { id, cabinetId: req.auth!.cabinetId },
    select: SELECT_FICHE,
  });
  if (!fiche) return null;
  if (req.auth!.role !== "titulaire" && fiche.userId !== req.auth!.userId) return undefined;
  return fiche;
}

personnelRouter.get("/api/personnel/:id", async (req, res) => {
  const fiche = await trouverFicheAccessible(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Tu ne peux consulter que ta propre fiche." });

  await logAuditPersonnel(fiche.id, "consultation_fiche", "succes", `Consultee par ${req.auth!.userId}`);
  return res.json(fiche);
});

const creerSchema = z.object({
  nom: z.string().trim().min(1, "Le nom est requis."),
  prenoms: z.string().trim().optional(),
  categorie: z.enum(CATEGORIES),
  fonction: z.string().trim().optional(),
  typeContrat: z.enum(TYPES_CONTRAT),
  dateEntree: z.string().min(1, "La date d'entrée est requise."),
  telephone: z.string().trim().optional(),
  email: z.string().trim().email().optional().or(z.literal("")),
  contactUrgence: z.string().trim().optional(),
  modePaiement: z.enum(MODES_PAIEMENT).optional(),
  coordonneesPaiement: z.string().trim().optional(),
  userId: z.string().uuid().optional(),
});

// Creation reservee au titulaire (pas d'avocat ici - voir docs/rh/00-audit.md,
// decision du 13/10/2026 : seul le titulaire gere le personnel par defaut
// tant que le Lot 9 n'existe pas pour deleguer finement).
personnelRouter.post("/api/personnel", async (req, res) => {
  if (req.auth!.role !== "titulaire") {
    return res.status(403).json({ error: "Seul le titulaire peut ajouter un employé." });
  }
  const parsed = creerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  if (parsed.data.userId) {
    const utilisateur = await prisma.user.findFirst({
      where: { id: parsed.data.userId, cabinetId: req.auth!.cabinetId },
    });
    if (!utilisateur) return res.status(404).json({ error: "Compte Aurore introuvable dans ce cabinet." });
    const dejaLie = await prisma.fichePersonnel.findUnique({ where: { userId: parsed.data.userId } });
    if (dejaLie) return res.status(409).json({ error: "Ce compte Aurore est déjà rattaché à une autre fiche personnel." });
  }

  const fiche = await prisma.fichePersonnel.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      nom: parsed.data.nom,
      prenoms: parsed.data.prenoms || null,
      categorie: parsed.data.categorie,
      fonction: parsed.data.fonction || null,
      typeContrat: parsed.data.typeContrat,
      dateEntree: new Date(parsed.data.dateEntree),
      telephone: parsed.data.telephone || null,
      email: parsed.data.email || null,
      contactUrgence: parsed.data.contactUrgence || null,
      modePaiement: parsed.data.modePaiement || null,
      coordonneesPaiement: parsed.data.coordonneesPaiement || null,
      userId: parsed.data.userId || null,
    },
    select: SELECT_FICHE,
  });

  await logAuditPersonnel(fiche.id, "creation_fiche", "succes", `Créée par ${req.auth!.userId}`);
  return res.status(201).json(fiche);
});

const modifierSchema = creerSchema.partial().extend({
  statut: z.enum(["actif", "sorti"]).optional(),
  dateSortie: z.string().trim().optional().nullable(),
});

personnelRouter.patch("/api/personnel/:id", async (req, res) => {
  if (req.auth!.role !== "titulaire") {
    return res.status(403).json({ error: "Seul le titulaire peut modifier une fiche personnel." });
  }
  const parsed = modifierSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const existante = await prisma.fichePersonnel.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!existante) return res.status(404).json({ error: "Fiche introuvable" });

  if (parsed.data.userId && parsed.data.userId !== existante.userId) {
    const utilisateur = await prisma.user.findFirst({
      where: { id: parsed.data.userId, cabinetId: req.auth!.cabinetId },
    });
    if (!utilisateur) return res.status(404).json({ error: "Compte Aurore introuvable dans ce cabinet." });
    const dejaLie = await prisma.fichePersonnel.findUnique({ where: { userId: parsed.data.userId } });
    if (dejaLie) return res.status(409).json({ error: "Ce compte Aurore est déjà rattaché à une autre fiche personnel." });
  }

  const { dateEntree, dateSortie, email, ...reste } = parsed.data;
  const fiche = await prisma.fichePersonnel.update({
    where: { id: existante.id },
    data: {
      ...reste,
      ...(email !== undefined ? { email: email || null } : {}),
      ...(dateEntree ? { dateEntree: new Date(dateEntree) } : {}),
      ...(dateSortie !== undefined ? { dateSortie: dateSortie ? new Date(dateSortie) : null } : {}),
    },
    select: SELECT_FICHE,
  });

  await logAuditPersonnel(fiche.id, "modification_fiche", "succes", `Modifiée par ${req.auth!.userId}`);
  return res.json(fiche);
});
