import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/roles";

export const auditLogsRouter = Router();

const querySchema = z.object({
  statut: z.enum(["succes", "erreur"]).optional(),
  // Ne renvoie que les entrees des N derniers mois (permet de "classer" par
  // periode) - absent = pas de filtre de date.
  depuisMois: z.coerce.number().int().positive().max(60).optional(),
  // Filtre par acteur : ne renvoie que les documents generes par ce membre
  // du cabinet - absent = tous les acteurs.
  genereParId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

// Journal d'audit du cabinet : chaque etape technique (extraction IA,
// redaction IA, envoi email...) d'une action, avec son statut. Reserve a
// l'admin - c'est un outil de suivi/securite, pas une donnee metier courante.
auditLogsRouter.get("/api/audit-logs", requireAuth, requireAdmin, async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const { statut, depuisMois, genereParId, limit } = parsed.data;

  const depuisDate = depuisMois
    ? new Date(new Date().setMonth(new Date().getMonth() - depuisMois))
    : undefined;

  const logs = await prisma.auditLog.findMany({
    where: {
      statut,
      timestamp: depuisDate ? { gte: depuisDate } : undefined,
      action: {
        dossier: { cabinetId: req.auth!.cabinetId },
        ...(genereParId ? { createdBy: genereParId } : {}),
      },
    },
    include: {
      action: {
        select: {
          typeAction: true,
          canal: true,
          dossier: { select: { numeroDossier: true, nomAffaire: true } },
          creePar: { select: { nom: true } },
        },
      },
    },
    orderBy: { timestamp: "desc" },
    take: limit,
  });

  // log.action est garanti non-null ici : le where ci-dessus filtre deja sur
  // des champs imbriques de cette relation (Prisma exclut donc toute ligne
  // ou elle serait absente) - non-null assertion sans risque. Depuis le Lot
  // 20, AuditLog.actionId est devenu facultatif (extension additive pour
  // couvrir aussi les evenements courrier, voir services/audit.ts), mais
  // cette page reste strictement celle des Actions.
  return res.json(
    logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      etape: log.etape,
      statut: log.statut,
      detail: log.detail,
      typeAction: log.action!.typeAction,
      canal: log.action!.canal,
      numeroDossier: log.action!.dossier.numeroDossier,
      nomAffaire: log.action!.dossier.nomAffaire,
      genereParNom: log.action!.creePar.nom,
    }))
  );
});

const connexionsQuerySchema = z.object({
  depuisMois: z.coerce.number().int().positive().max(60).optional(),
  userId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

// Journal des connexions (2026-10-13) : qui s'est connecte, quand, et
// pendant combien de temps (duree calculee cote client a partir de
// connecteLe/derniereActiviteLe/deconnecteLe - voir JournalConnexion).
auditLogsRouter.get("/api/audit-logs/connexions", requireAuth, requireAdmin, async (req, res) => {
  const parsed = connexionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const { depuisMois, userId, limit } = parsed.data;
  const depuisDate = depuisMois ? new Date(new Date().setMonth(new Date().getMonth() - depuisMois)) : undefined;

  const connexions = await prisma.journalConnexion.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      connecteLe: depuisDate ? { gte: depuisDate } : undefined,
      userId,
    },
    include: { user: { select: { nom: true, role: true } } },
    orderBy: { connecteLe: "desc" },
    take: limit,
  });

  return res.json(
    connexions.map((c) => ({
      id: c.id,
      userNom: c.user.nom,
      userRole: c.user.role,
      connecteLe: c.connecteLe,
      derniereActiviteLe: c.derniereActiviteLe,
      deconnecteLe: c.deconnecteLe,
      adresseIp: c.adresseIp,
    }))
  );
});

const activiteQuerySchema = z.object({
  depuisMois: z.coerce.number().int().positive().max(60).optional(),
  userId: z.string().uuid().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

// Journal d'activite (2026-10-13) : actions metier (dossiers, clients,
// factures, comptes) - distinct du journal technique ci-dessus (pipeline
// de generation de documents).
auditLogsRouter.get("/api/audit-logs/activite", requireAuth, requireAdmin, async (req, res) => {
  const parsed = activiteQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const { depuisMois, userId, type, limit } = parsed.data;
  const depuisDate = depuisMois ? new Date(new Date().setMonth(new Date().getMonth() - depuisMois)) : undefined;

  const activites = await prisma.journalActivite.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      createdAt: depuisDate ? { gte: depuisDate } : undefined,
      userId,
      type,
    },
    include: { user: { select: { nom: true, role: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return res.json(
    activites.map((a) => ({
      id: a.id,
      userNom: a.user?.nom ?? null,
      userRole: a.user?.role ?? null,
      type: a.type,
      cible: a.cible,
      detail: a.detail,
      createdAt: a.createdAt,
    }))
  );
});

const mobileQuerySchema = z.object({
  depuisMois: z.coerce.number().int().positive().max(60).optional(),
  statut: z.enum(["succes", "erreur"]).optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

// Journal mobile (Lot 10, deja alimente depuis le 2026-10-09 - appairage,
// elements recus/supprimes/classes, echecs d'authentification...) : jamais
// expose dans une page avant ce chantier (2026-10-13), seulement ecrit.
auditLogsRouter.get("/api/audit-logs/mobile", requireAuth, requireAdmin, async (req, res) => {
  const parsed = mobileQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const { depuisMois, statut, limit } = parsed.data;
  const depuisDate = depuisMois ? new Date(new Date().setMonth(new Date().getMonth() - depuisMois)) : undefined;

  const logs = await prisma.mobileAuditLog.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      statut,
      timestamp: depuisDate ? { gte: depuisDate } : undefined,
    },
    include: { device: { select: { nomDeclare: true, user: { select: { nom: true } } } } },
    orderBy: { timestamp: "desc" },
    take: limit,
  });

  return res.json(
    logs.map((log) => ({
      id: log.id,
      timestamp: log.timestamp,
      etape: log.etape,
      statut: log.statut,
      detail: log.detail,
      appareilNom: log.device?.nomDeclare ?? null,
      appareilProprietaire: log.device?.user?.nom ?? null,
    }))
  );
});

const purgeQuerySchema = z.object({
  // Supprime les entrees STRICTEMENT PLUS VIEILLES que N mois - jamais les
  // plus recentes, pour alleger la liste sans perdre l'historique utile.
  plusVieuxQueMois: z.coerce.number().int().positive().max(60),
});

auditLogsRouter.delete("/api/audit-logs", requireAuth, requireAdmin, async (req, res) => {
  const parsed = purgeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const cutoff = new Date(new Date().setMonth(new Date().getMonth() - parsed.data.plusVieuxQueMois));

  const { count } = await prisma.auditLog.deleteMany({
    where: {
      timestamp: { lt: cutoff },
      action: { dossier: { cabinetId: req.auth!.cabinetId } },
    },
  });
  return res.json({ deleted: count });
});
