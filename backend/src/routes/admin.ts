import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireSuperAdmin } from "../middleware/roles";
import { hashPassword } from "../services/auth";

export const adminRouter = Router();

adminRouter.use("/api/admin", requireAuth, requireSuperAdmin);

// Cles de modules geres par la plateforme - toute autre valeur est rejetee
// a la creation/modification pour eviter des cles orphelines qu'aucun
// module ne verifie jamais.
export const MODULES_DISPONIBLES = ["facturation", "veille_juridique", "jurisprudence", "delais"] as const;

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
      select: { id: true, nom: true, email: true, role: true, actif: true, lastLoginAt: true },
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
});

// Onboarding d'un nouveau cabinet client : cree le cabinet et son premier
// compte (titulaire), avec un mot de passe genere une seule fois - a
// transmettre au client, jamais reaffiche ensuite.
adminRouter.post("/api/admin/cabinets", async (req, res) => {
  const parsed = createCabinetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const { nom, adresse, titulaireNom, titulaireEmail } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email: titulaireEmail } });
  if (existing) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
  }

  const cabinet = await prisma.cabinet.create({
    data: { nom, adresse: adresse || null },
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

  const updated = await prisma.cabinet.update({
    where: { id: cabinet.id },
    data: parsed.data,
  });

  return res.json(updated);
});
