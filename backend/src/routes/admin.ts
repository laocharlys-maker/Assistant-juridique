import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireSuperAdmin } from "../middleware/roles";
import { hashPassword } from "../services/auth";
import { buildFacturePdf } from "../services/facturePdf";
import { callN8nWebhook } from "../services/n8n";

export const adminRouter = Router();

adminRouter.use("/api/admin", requireAuth, requireSuperAdmin);

// Cles de modules geres par la plateforme - toute autre valeur est rejetee
// a la creation/modification pour eviter des cles orphelines qu'aucun
// module ne verifie jamais.
export const MODULES_DISPONIBLES = [
  "facturation",
  "veille_juridique",
  "jurisprudence",
  "delais",
  "nouvelle_action",
  "documents_generes",
] as const;

// Prefixe reserve aux factures d'ABONNEMENT emises par la plateforme a un
// cabinet client (distinct des series PROF-/FACT- que le cabinet utilise
// pour facturer SES PROPRES clients) - permet de filtrer les unes des
// autres sans champ supplementaire sur le modele Facture partage.
const PREFIXE_FACTURE_ABONNEMENT = "ABON";

// Cabinet technique reserve aux comptes super_admin (voir
// prisma/seedSuperAdmin.ts) - n'accueille jamais de client reel, ne doit
// donc jamais apparaitre dans la liste des cabinets a gerer.
const CABINET_PLATEFORME_ID = "00000000-0000-0000-0000-000000000000";

adminRouter.get("/api/admin/cabinets", async (_req, res) => {
  const cabinets = await prisma.cabinet.findMany({
    where: { id: { not: CABINET_PLATEFORME_ID } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      nom: true,
      actif: true,
      modulesDesactives: true,
      plan: true,
      essaiExpireLe: true,
      limiteDocumentsCabinetParMois: true,
      createdAt: true,
      _count: { select: { users: true, dossiers: true } },
    },
  });
  return res.json(cabinets);
});

// Vue d'ensemble plateforme : de quoi remplir le tableau de bord de la page
// d'administration, sans avoir a recalculer cote client.
adminRouter.get("/api/admin/stats", async (_req, res) => {
  const debutMois = new Date();
  debutMois.setDate(1);
  debutMois.setHours(0, 0, 0, 0);

  const septJoursAvant = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const cabinetsWhere = { id: { not: CABINET_PLATEFORME_ID } };

  const [totalCabinets, cabinetsActifs, nouveauxCeMois, totalUtilisateurs, cabinetsConnectesRecemment] =
    await Promise.all([
      prisma.cabinet.count({ where: cabinetsWhere }),
      prisma.cabinet.count({ where: { ...cabinetsWhere, actif: true } }),
      prisma.cabinet.count({ where: { ...cabinetsWhere, createdAt: { gte: debutMois } } }),
      prisma.user.count({ where: { cabinetId: { not: CABINET_PLATEFORME_ID } } }),
      prisma.user.findMany({
        where: { cabinetId: { not: CABINET_PLATEFORME_ID }, lastLoginAt: { gte: septJoursAvant } },
        select: { cabinetId: true },
        distinct: ["cabinetId"],
      }),
    ]);

  return res.json({
    totalCabinets,
    cabinetsActifs,
    cabinetsSuspendus: totalCabinets - cabinetsActifs,
    nouveauxCeMois,
    totalUtilisateurs,
    cabinetsConnectesCetteSemaine: cabinetsConnectesRecemment.length,
  });
});

// Activite d'un cabinet : type d'operations effectuees (docs generes...)
// sur les 30 derniers jours, et derniere connexion de chaque utilisateur -
// sert de base a la facturation manuelle, jamais le contenu des documents.
adminRouter.get("/api/admin/cabinets/:id/activite", async (req, res) => {
  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.params.id } });
  if (!cabinet) {
    return res.status(404).json({ error: "Cabinet introuvable" });
  }

  const trenteJoursAvant = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [operations, utilisateurs] = await Promise.all([
    prisma.action.groupBy({
      by: ["typeAction"],
      where: { dossier: { cabinetId: cabinet.id }, createdAt: { gte: trenteJoursAvant } },
      _count: { _all: true },
      orderBy: { _count: { typeAction: "desc" } },
    }),
    prisma.user.findMany({
      where: { cabinetId: cabinet.id },
      select: { id: true, nom: true, email: true, role: true, actif: true, lastLoginAt: true, limiteDocumentsParMois: true },
      orderBy: { nom: "asc" },
    }),
  ]);

  return res.json({
    periodeJours: 30,
    operations: operations.map((o) => ({ typeAction: o.typeAction, total: o._count._all })),
    utilisateurs,
  });
});

const createCabinetSchema = z.object({
  nom: z.string().min(1),
  adresse: z.string().optional(),
  titulaireNom: z.string().min(1),
  titulaireEmail: z.string().email(),
  // Duree d'essai en jours a partir de maintenant (ex: 7) - absent = acces
  // permanent des la creation, pas de date d'expiration.
  essaiJours: z.number().int().positive().max(365).optional(),
});

// Onboarding d'un nouveau cabinet client : cree le cabinet et son premier
// compte (titulaire), avec un mot de passe genere une seule fois - a
// transmettre au client, jamais reaffiche ensuite.
adminRouter.post("/api/admin/cabinets", async (req, res) => {
  const parsed = createCabinetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const { nom, adresse, titulaireNom, titulaireEmail, essaiJours } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: titulaireEmail } });
  if (existing) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
  }

  const cabinet = await prisma.cabinet.create({
    data: {
      nom,
      adresse: adresse || null,
      essaiExpireLe: essaiJours ? new Date(Date.now() + essaiJours * 24 * 60 * 60 * 1000) : null,
    },
  });

  const plainPassword = crypto.randomBytes(9).toString("base64url");
  const titulaire = await prisma.user.create({
    data: {
      cabinetId: cabinet.id,
      nom: titulaireNom,
      email: titulaireEmail,
      motDePasseHash: await hashPassword(plainPassword),
      role: "titulaire",
    },
  });

  return res.status(201).json({
    cabinet,
    titulaire: { id: titulaire.id, nom: titulaire.nom, email: titulaire.email, password: plainPassword },
  });
});

const updateCabinetSchema = z.object({
  actif: z.boolean().optional(),
  modulesDesactives: z.array(z.enum(MODULES_DISPONIBLES)).optional(),
  nom: z.string().min(1).optional(),
  adresse: z.string().optional(),
  plan: z.string().optional(),
  // Nombre de jours a ajouter a MAINTENANT (ou a la date d'expiration en
  // cours si elle est deja dans le futur) - c'est la "reconduction
  // manuelle" de l'essai. 0 ou absent = pas de changement d'essai.
  prolongerJours: z.number().int().positive().max(365).optional(),
  // Retire toute limite d'essai (acces permanent).
  retirerLimiteEssai: z.boolean().optional(),
  limiteDocumentsCabinetParMois: z.number().int().positive().max(100000).nullable().optional(),
});

adminRouter.patch("/api/admin/cabinets/:id", async (req, res) => {
  const parsed = updateCabinetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.params.id } });
  if (!cabinet) {
    return res.status(404).json({ error: "Cabinet introuvable" });
  }

  const { prolongerJours, retirerLimiteEssai, ...champs } = parsed.data;

  let essaiExpireLe: Date | null | undefined;
  if (retirerLimiteEssai) {
    essaiExpireLe = null;
  } else if (prolongerJours) {
    const base = cabinet.essaiExpireLe && cabinet.essaiExpireLe.getTime() > Date.now() ? cabinet.essaiExpireLe : new Date();
    essaiExpireLe = new Date(base.getTime() + prolongerJours * 24 * 60 * 60 * 1000);
  }

  const updated = await prisma.cabinet.update({
    where: { id: cabinet.id },
    data: { ...champs, ...(essaiExpireLe !== undefined ? { essaiExpireLe } : {}) },
  });

  return res.json(updated);
});

const updateUserQuotaSchema = z.object({
  limiteDocumentsParMois: z.number().int().positive().max(100000).nullable(),
});

// Plafond mensuel de generation de documents impose par la plateforme sur
// UN compte precis (tous roles confondus) - distinct du quota interne que
// le cabinet fixe lui-meme pour ses collaborateurs dans Parametres.
adminRouter.patch("/api/admin/users/:id/quota", async (req, res) => {
  const parsed = updateUserQuotaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const user = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!user) {
    return res.status(404).json({ error: "Compte introuvable" });
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { limiteDocumentsParMois: parsed.data.limiteDocumentsParMois },
  });

  return res.json({ id: updated.id, limiteDocumentsParMois: updated.limiteDocumentsParMois });
});

const auditLogsQuerySchema = z.object({
  statut: z.enum(["succes", "erreur"]).optional(),
  cabinetId: z.string().uuid().optional(),
  depuisMois: z.coerce.number().int().positive().max(60).optional(),
  limit: z.coerce.number().int().positive().max(500).default(200),
});

// Journal d'audit PLATEFORME : meme donnee que /api/audit-logs (cote
// cabinet), mais tous cabinets confondus - permet a l'exploitant de
// surveiller les erreurs techniques sans avoir a se connecter comme chaque
// client.
adminRouter.get("/api/admin/audit-logs", async (req, res) => {
  const parsed = auditLogsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }
  const { statut, cabinetId, depuisMois, limit } = parsed.data;

  const depuisDate = depuisMois ? new Date(new Date().setMonth(new Date().getMonth() - depuisMois)) : undefined;

  const logs = await prisma.auditLog.findMany({
    where: {
      statut,
      timestamp: depuisDate ? { gte: depuisDate } : undefined,
      action: {
        dossier: { cabinetId: cabinetId ?? { not: CABINET_PLATEFORME_ID } },
      },
    },
    include: {
      action: {
        select: {
          typeAction: true,
          canal: true,
          dossier: { select: { numeroDossier: true, nomAffaire: true, cabinet: { select: { id: true, nom: true } } } },
          creePar: { select: { nom: true } },
        },
      },
    },
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
      typeAction: log.action.typeAction,
      canal: log.action.canal,
      cabinet: log.action.dossier?.cabinet ?? null,
      dossier: log.action.dossier
        ? { numeroDossier: log.action.dossier.numeroDossier, nomAffaire: log.action.dossier.nomAffaire }
        : null,
      genrePar: log.action.creePar.nom,
    }))
  );
});

async function genererNumeroAbonnement(cabinetId: string): Promise<string> {
  const annee = new Date().getFullYear();
  const count = await prisma.facture.count({
    where: { cabinetId, numero: { startsWith: `${PREFIXE_FACTURE_ABONNEMENT}-${annee}-` } },
  });
  return `${PREFIXE_FACTURE_ABONNEMENT}-${annee}-${String(count + 1).padStart(4, "0")}`;
}

const createFactureAbonnementSchema = z.object({
  description: z.string().min(1),
  montant: z.number().int().positive(),
  appliquerTva: z.boolean().optional().default(false),
  estProforma: z.boolean().optional().default(true),
  dateEcheance: z.string().optional(),
});

// Facture emise par la PLATEFORME a destination d'un cabinet client, pour
// son abonnement Aurore - distincte des factures que le cabinet emet lui
// meme a ses propres clients (module "facturation").
adminRouter.post("/api/admin/cabinets/:id/factures", async (req, res) => {
  const parsed = createFactureAbonnementSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.params.id } });
  if (!cabinet) {
    return res.status(404).json({ error: "Cabinet introuvable" });
  }

  const numero = await genererNumeroAbonnement(cabinet.id);

  const facture = await prisma.facture.create({
    data: {
      cabinetId: cabinet.id,
      clientNom: cabinet.nom,
      numero,
      description: parsed.data.description,
      montant: parsed.data.montant,
      appliquerTva: parsed.data.appliquerTva,
      estProforma: parsed.data.estProforma,
      dateEcheance: parsed.data.dateEcheance ? new Date(parsed.data.dateEcheance) : undefined,
      createdBy: req.auth!.userId,
    },
  });

  return res.status(201).json(facture);
});

adminRouter.get("/api/admin/cabinets/:id/factures", async (req, res) => {
  const factures = await prisma.facture.findMany({
    where: { cabinetId: req.params.id, numero: { startsWith: `${PREFIXE_FACTURE_ABONNEMENT}-` } },
    orderBy: { createdAt: "desc" },
  });
  return res.json(factures);
});

async function loadFactureAbonnement(id: string) {
  const facture = await prisma.facture.findUnique({ where: { id } });
  if (!facture || !facture.numero.startsWith(`${PREFIXE_FACTURE_ABONNEMENT}-`)) return null;
  return facture;
}

const updateFactureAbonnementSchema = z.object({
  statut: z.enum(["brouillon", "envoyee", "payee"]),
});

adminRouter.patch("/api/admin/factures/:id", async (req, res) => {
  const parsed = updateFactureAbonnementSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  const facture = await loadFactureAbonnement(req.params.id);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }

  const updated = await prisma.facture.update({
    where: { id: facture.id },
    data: { statut: parsed.data.statut, payeeAt: parsed.data.statut === "payee" ? new Date() : facture.payeeAt },
  });

  return res.json(updated);
});

adminRouter.get("/api/admin/factures/:id/pdf", async (req, res) => {
  const facture = await loadFactureAbonnement(req.params.id);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }
  const cabinet = await prisma.cabinet.findUnique({ where: { id: facture.cabinetId } });

  const buffer = await buildFacturePdf({
    cabinetNom: "Aurore",
    numero: facture.numero,
    dateEmission: facture.dateEmission,
    dateEcheance: facture.dateEcheance,
    nomClient: cabinet?.nom ?? facture.clientNom ?? "-",
    numeroDossier: null,
    nomAffaire: null,
    description: facture.description,
    montant: facture.montant,
    appliquerTva: facture.appliquerTva,
    estProforma: facture.estProforma,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${facture.numero}.pdf"`);
  return res.send(buffer);
});

const envoyerFactureAbonnementSchema = z.object({
  email: z.string().email(),
});

adminRouter.post("/api/admin/factures/:id/envoyer", async (req, res) => {
  const parsed = envoyerFactureAbonnementSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Email invalide" });
  }

  const facture = await loadFactureAbonnement(req.params.id);
  if (!facture) {
    return res.status(404).json({ error: "Facture introuvable" });
  }
  const cabinet = await prisma.cabinet.findUnique({ where: { id: facture.cabinetId } });

  const buffer = await buildFacturePdf({
    cabinetNom: "Aurore",
    numero: facture.numero,
    dateEmission: facture.dateEmission,
    dateEcheance: facture.dateEcheance,
    nomClient: cabinet?.nom ?? facture.clientNom ?? "-",
    numeroDossier: null,
    nomAffaire: null,
    description: facture.description,
    montant: facture.montant,
    appliquerTva: facture.appliquerTva,
    estProforma: facture.estProforma,
  });

  const n8nResult = await callN8nWebhook("envoyer-facture", {
    factureId: facture.id,
    cabinetNom: "Aurore",
    numero: facture.numero,
    montant: facture.montant,
    description: facture.description,
    destinataireEmail: parsed.data.email,
    pdfBase64: buffer.toString("base64"),
  });

  if (!n8nResult.ok) {
    return res.status(502).json({ error: "Échec de l'envoi de la facture", detail: n8nResult.error });
  }

  const updated = await prisma.facture.update({
    where: { id: facture.id },
    data: { statut: "envoyee", destinataireEmail: parsed.data.email, envoyeAt: new Date() },
  });

  return res.json(updated);
});
