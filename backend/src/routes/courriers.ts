import { Router } from "express";
import { z } from "zod";
import { NatureCourrier, ModeCourrier, StatutCourrierEntrant, StatutCourrierSortant } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import * as courrierService from "../services/courriers/courrierService";

export const courriersRouter = Router();

// Module payant : voir routes/factures.ts pour le meme raisonnement (chemins
// explicites obligatoires, sinon ce middleware s'appliquerait a toutes les
// requetes de l'app puisque ce routeur est monte sans prefixe sur app).
courriersRouter.use(["/api/courriers-entrants", "/api/courriers-sortants"], requireAuth, requireModule("courriers"));

function messageErreur(error: unknown): { statut: number; error: string } {
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "CLIENT_INTROUVABLE":
      return { statut: 404, error: "Client introuvable" };
    case "DOSSIER_INTROUVABLE":
      return { statut: 404, error: "Dossier introuvable" };
    case "COURRIER_INTROUVABLE":
      return { statut: 404, error: "Courrier introuvable" };
    case "COURRIER_ORIGINE_INTROUVABLE":
      return { statut: 404, error: "Courrier d'origine introuvable" };
    case "UTILISATEUR_INTROUVABLE":
      return { statut: 404, error: "Utilisateur introuvable" };
    case "ACTION_INTROUVABLE":
      return { statut: 404, error: "Action introuvable" };
    case "ACTION_DOSSIER_DIFFERENT":
      return { statut: 409, error: "Cette action concerne un autre dossier que celui du courrier." };
    case "TYPE_DELAI_INTROUVABLE":
      return { statut: 404, error: "Type de délai introuvable ou inactif" };
    case "TRANSITION_INVALIDE":
      return { statut: 409, error: "Cette transition de statut n'est pas autorisée depuis le statut actuel." };
    case "FICHIER_INVALIDE":
      return { statut: 400, error: "Fichier invalide (format inattendu)." };
    case "FICHIER_VIDE":
      return { statut: 400, error: "Fichier vide." };
    default:
      throw error;
  }
}

// ---------------------------------------------------------------------------
// Courriers ENTRANTS
// ---------------------------------------------------------------------------

const listeEntrantsQuerySchema = z.object({
  q: z.string().optional(),
  nature: z.nativeEnum(NatureCourrier).optional(),
  statut: z.nativeEnum(StatutCourrierEntrant).optional(),
  clientId: z.string().uuid().optional(),
  dossierId: z.string().uuid().optional(),
  affecteAId: z.string().uuid().optional(),
  vue: z.enum(["aujourdhui", "a_traiter", "a_affecter", "avec_echeance", "archives"]).optional(),
});

courriersRouter.get("/api/courriers-entrants", requireAuth, async (req, res) => {
  const parsed = listeEntrantsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Filtres invalides", details: parsed.error.issues });
  }
  const courriers = await courrierService.listerCourriersEntrants(req.auth!.cabinetId, parsed.data);
  return res.json(courriers);
});

courriersRouter.get("/api/courriers-entrants/compteurs", requireAuth, async (req, res) => {
  const compteurs = await courrierService.compterCourriers(req.auth!.cabinetId);
  return res.json(compteurs);
});

// "Notification" d'affectation (voir courrierService.compterCourriersAffectesA) -
// interrogee par polling depuis public/js/layout.js, meme esprit que
// GET /api/veille-juridique/derniere.
courriersRouter.get("/api/courriers-entrants/notifications", requireAuth, async (req, res) => {
  const enAttente = await courrierService.compterCourriersAffectesA(req.auth!.cabinetId, req.auth!.userId);
  return res.json({ enAttente });
});

// "Un seul champ obligatoire a la creation : l'objet" - contrainte
// explicite du prompt, tout le reste est optionnel.
const creerEntrantSchema = z.object({
  objet: z.string().min(1),
  nature: z.nativeEnum(NatureCourrier).optional(),
  expediteur: z.string().min(1).optional(),
  dateCourrier: z.string().optional(),
  dateReception: z.string().optional(),
  modeReception: z.nativeEnum(ModeCourrier).optional(),
  clientId: z.string().uuid().optional(),
  dossierId: z.string().uuid().optional(),
  observations: z.string().optional(),
});

courriersRouter.post("/api/courriers-entrants", requireAuth, async (req, res) => {
  const parsed = creerEntrantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const courrier = await courrierService.creerCourrierEntrant(req.auth!.cabinetId, req.auth!.userId, {
      ...parsed.data,
      dateCourrier: parsed.data.dateCourrier ? new Date(parsed.data.dateCourrier) : undefined,
      dateReception: parsed.data.dateReception ? new Date(parsed.data.dateReception) : undefined,
    });
    return res.status(201).json(courrier);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

courriersRouter.get("/api/courriers-entrants/:id", requireAuth, async (req, res) => {
  const courrier = await courrierService.obtenirCourrierEntrant(req.params.id, req.auth!.cabinetId);
  if (!courrier) return res.status(404).json({ error: "Courrier introuvable" });
  return res.json(courrier);
});

const majEntrantSchema = z.object({
  objet: z.string().min(1).optional(),
  nature: z.nativeEnum(NatureCourrier).nullable().optional(),
  expediteur: z.string().nullable().optional(),
  dateCourrier: z.string().nullable().optional(),
  modeReception: z.nativeEnum(ModeCourrier).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  dossierId: z.string().uuid().nullable().optional(),
  observations: z.string().nullable().optional(),
});

courriersRouter.patch("/api/courriers-entrants/:id", requireAuth, async (req, res) => {
  const parsed = majEntrantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const courrier = await courrierService.mettreAJourCourrierEntrant(req.params.id, req.auth!.cabinetId, {
      ...parsed.data,
      dateCourrier: parsed.data.dateCourrier === undefined ? undefined : parsed.data.dateCourrier ? new Date(parsed.data.dateCourrier) : null,
    });
    return res.json(courrier);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

const affecterSchema = z.object({ affecteAId: z.string().uuid() });

courriersRouter.post("/api/courriers-entrants/:id/affecter", requireAuth, async (req, res) => {
  const parsed = affecterSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const courrier = await courrierService.affecterCourrierEntrant(req.params.id, req.auth!.cabinetId, parsed.data.affecteAId);
    return res.json(courrier);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

const changerStatutSchema = z.object({ statut: z.nativeEnum(StatutCourrierEntrant) });

courriersRouter.post("/api/courriers-entrants/:id/statut", requireAuth, async (req, res) => {
  const parsed = changerStatutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const courrier = await courrierService.changerStatutCourrierEntrant(req.params.id, req.auth!.cabinetId, parsed.data.statut);
    return res.json(courrier);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

const creerDelaiSchema = z.object({ delaiTypeId: z.string().uuid(), dateDepart: z.string().min(1) });

courriersRouter.post("/api/courriers-entrants/:id/delai", requireAuth, async (req, res) => {
  const parsed = creerDelaiSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const dateDepart = new Date(parsed.data.dateDepart);
  if (Number.isNaN(dateDepart.getTime())) {
    return res.status(400).json({ error: "Date de départ invalide" });
  }
  try {
    const calcul = await courrierService.creerDelaiDepuisCourrierEntrant(req.params.id, req.auth!.cabinetId, req.auth!.userId, {
      delaiTypeId: parsed.data.delaiTypeId,
      dateDepart,
    });
    return res.status(201).json(calcul);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

const lierActionSchema = z.object({ actionId: z.string().uuid() });

courriersRouter.post("/api/courriers-entrants/:id/lier-action", requireAuth, async (req, res) => {
  const parsed = lierActionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const action = await courrierService.lierActionACourrierEntrant(req.params.id, req.auth!.cabinetId, parsed.data.actionId);
    return res.json(action);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

const uploadPieceSchema = z.object({ nom: z.string().min(1), fichierDataUrl: z.string().min(1) });

courriersRouter.post("/api/courriers-entrants/:id/pieces", requireAuth, async (req, res) => {
  const parsed = uploadPieceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const resultat = await courrierService.uploaderPieceCourrierEntrant(req.params.id, req.auth!.cabinetId, req.auth!.userId, parsed.data);
    return res.status(201).json(resultat);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// Courriers SORTANTS
// ---------------------------------------------------------------------------

const listeSortantsQuerySchema = z.object({
  q: z.string().optional(),
  nature: z.nativeEnum(NatureCourrier).optional(),
  statut: z.nativeEnum(StatutCourrierSortant).optional(),
  clientId: z.string().uuid().optional(),
  dossierId: z.string().uuid().optional(),
  vue: z.enum(["ce_mois", "archives"]).optional(),
});

courriersRouter.get("/api/courriers-sortants", requireAuth, async (req, res) => {
  const parsed = listeSortantsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Filtres invalides", details: parsed.error.issues });
  }
  const courriers = await courrierService.listerCourriersSortants(req.auth!.cabinetId, parsed.data);
  return res.json(courriers);
});

const creerSortantSchema = z.object({
  objet: z.string().min(1),
  nature: z.nativeEnum(NatureCourrier).optional(),
  destinataire: z.string().min(1).optional(),
  dateCourrier: z.string().optional(),
  modeEnvoi: z.nativeEnum(ModeCourrier).optional(),
  clientId: z.string().uuid().optional(),
  dossierId: z.string().uuid().optional(),
  observations: z.string().optional(),
  reponseAId: z.string().uuid().optional(),
});

courriersRouter.post("/api/courriers-sortants", requireAuth, async (req, res) => {
  const parsed = creerSortantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const courrier = await courrierService.creerCourrierSortant(req.auth!.cabinetId, req.auth!.userId, {
      ...parsed.data,
      dateCourrier: parsed.data.dateCourrier ? new Date(parsed.data.dateCourrier) : undefined,
    });
    return res.status(201).json(courrier);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

courriersRouter.get("/api/courriers-sortants/:id", requireAuth, async (req, res) => {
  const courrier = await courrierService.obtenirCourrierSortant(req.params.id, req.auth!.cabinetId);
  if (!courrier) return res.status(404).json({ error: "Courrier introuvable" });
  return res.json(courrier);
});

const majSortantSchema = z.object({
  objet: z.string().min(1).optional(),
  nature: z.nativeEnum(NatureCourrier).nullable().optional(),
  destinataire: z.string().nullable().optional(),
  dateCourrier: z.string().nullable().optional(),
  modeEnvoi: z.nativeEnum(ModeCourrier).nullable().optional(),
  clientId: z.string().uuid().nullable().optional(),
  dossierId: z.string().uuid().nullable().optional(),
  observations: z.string().nullable().optional(),
});

courriersRouter.patch("/api/courriers-sortants/:id", requireAuth, async (req, res) => {
  const parsed = majSortantSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const courrier = await courrierService.mettreAJourCourrierSortant(req.params.id, req.auth!.cabinetId, {
      ...parsed.data,
      dateCourrier: parsed.data.dateCourrier === undefined ? undefined : parsed.data.dateCourrier ? new Date(parsed.data.dateCourrier) : null,
    });
    return res.json(courrier);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

courriersRouter.post("/api/courriers-sortants/:id/envoyer", requireAuth, async (req, res) => {
  try {
    const courrier = await courrierService.envoyerCourrierSortant(req.params.id, req.auth!.cabinetId);
    return res.json(courrier);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

courriersRouter.post("/api/courriers-sortants/:id/classer", requireAuth, async (req, res) => {
  try {
    const courrier = await courrierService.classerCourrierSortant(req.params.id, req.auth!.cabinetId);
    return res.json(courrier);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

courriersRouter.post("/api/courriers-sortants/:id/pieces", requireAuth, async (req, res) => {
  const parsed = uploadPieceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const resultat = await courrierService.uploaderPieceCourrierSortant(req.params.id, req.auth!.cabinetId, req.auth!.userId, parsed.data);
    return res.status(201).json(resultat);
  } catch (error) {
    const { statut, error: message } = messageErreur(error);
    return res.status(statut).json({ error: message });
  }
});

// Liste des collaborateurs/avocats du cabinet, pour le selecteur "Affecter à"
// (meme portee que les autres selecteurs d'utilisateurs de l'app - pas de
// nouveau systeme de droits).
courriersRouter.get("/api/courriers-entrants-affectables", requireAuth, requireModule("courriers"), async (req, res) => {
  const utilisateurs = await prisma.user.findMany({
    where: { cabinetId: req.auth!.cabinetId, actif: true, role: { in: ["titulaire", "avocat", "collaborateur"] } },
    select: { id: true, nom: true, role: true },
    orderBy: { nom: "asc" },
  });
  return res.json(utilisateurs);
});
