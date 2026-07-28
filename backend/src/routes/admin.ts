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
      createdAt: true,
      _count: { select: { users: true, dossiers: true } },
    },
  });
  return res.json(cabinets);
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
