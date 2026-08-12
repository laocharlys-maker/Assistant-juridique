import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { verifyPassword, hashPassword, signAuthToken } from "../services/auth";
import { requireAuth } from "../middleware/requireAuth";
import { loginLimiter } from "../middleware/rateLimit";
import { env } from "../config/env";

export const authRouter = Router();

// Cabinet technique reserve aux comptes super_admin (voir
// prisma/seedSuperAdmin.ts, routes/admin.ts) - jamais compte comme un
// "vrai" cabinet pour decider si le premier lancement doit s'afficher.
const CABINET_PLATEFORME_ID = "00000000-0000-0000-0000-000000000000";

/**
 * "Premier lancement" (creation du tout premier cabinet + compte
 * titulaire, SANS authentification prealable) : UNIQUEMENT en mode
 * desktop (DATABASE_MODE=portable, chaque poste a sa propre base isolee) -
 * jamais en mode "externe" (VPS multi-cabinets), ou n'importe qui pourrait
 * creer un cabinet sans passer par l'onboarding controle de la plateforme
 * (voir routes/admin.ts, POST /api/admin/cabinets, reserve au super_admin).
 * En mode portable, il n'existe justement AUCUN super_admin ni aucun autre
 * moyen de creer le premier compte (seedSuperAdmin.ts suppose un acces
 * `npx`/au code source, absent d'un poste client) - ce chemin comble ce
 * vide plutot que de laisser un cabinet dont la base a ete reinitialisee
 * durablement bloque hors de l'application.
 */
function premierLancementDisponible(): boolean {
  return (process.env.DATABASE_MODE || "externe").toLowerCase() === "portable";
}

async function aucunCabinetReel(): Promise<boolean> {
  const count = await prisma.cabinet.count({ where: { id: { not: CABINET_PLATEFORME_ID } } });
  return count === 0;
}

authRouter.get("/api/auth/premier-lancement", async (_req, res) => {
  const disponible = premierLancementDisponible() && (await aucunCabinetReel());
  return res.json({ disponible });
});

const premierLancementSchema = z.object({
  cabinetNom: z.string().min(1),
  nom: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8, "Le mot de passe doit faire au moins 8 caractères"),
});

authRouter.post("/api/auth/premier-lancement", loginLimiter, async (req, res) => {
  if (!premierLancementDisponible()) {
    return res.status(403).json({ error: "Cette action n'est disponible qu'en mode desktop, lors du tout premier lancement." });
  }
  if (!(await aucunCabinetReel())) {
    return res.status(409).json({ error: "Un cabinet existe déjà sur ce poste — utilise le formulaire de connexion habituel." });
  }

  const parsed = premierLancementSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const { cabinetNom, nom, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
  }

  const cabinet = await prisma.cabinet.create({ data: { nom: cabinetNom } });
  const titulaire = await prisma.user.create({
    data: {
      cabinetId: cabinet.id,
      nom,
      email,
      motDePasseHash: await hashPassword(password),
      role: "titulaire",
    },
  });

  console.log(`[auth] premier lancement : cabinet "${cabinet.nom}" créé avec le titulaire ${titulaire.email}.`);

  // Connecte directement (meme comportement qu'un login reussi) - evite un
  // aller-retour inutile vers l'ecran de connexion juste apres la creation.
  const token = signAuthToken({ userId: titulaire.id, cabinetId: cabinet.id, role: titulaire.role });
  res.cookie("aurore_session", token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.status(201).json({ id: titulaire.id, nom: titulaire.nom, email: titulaire.email, role: titulaire.role });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post("/api/auth/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Email ou mot de passe invalide" });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({
    where: { email },
    include: { cabinet: { select: { actif: true, essaiExpireLe: true } } },
  });
  if (!user) {
    return res.status(401).json({ error: "Identifiants incorrects" });
  }

  const validPassword = await verifyPassword(password, user.motDePasseHash);
  if (!validPassword) {
    return res.status(401).json({ error: "Identifiants incorrects" });
  }

  if (!user.actif) {
    return res.status(403).json({ error: "Ce compte a été désactivé. Contacte l'administrateur du cabinet." });
  }

  if (user.role !== "super_admin") {
    if (!user.cabinet.actif) {
      return res.status(403).json({ error: "L'accès de ce cabinet a été suspendu. Contactez l'administrateur de la plateforme." });
    }
    if (user.cabinet.essaiExpireLe && user.cabinet.essaiExpireLe.getTime() < Date.now()) {
      return res.status(403).json({ error: "La période d'accès de ce cabinet a expiré. Contactez l'administrateur de la plateforme." });
    }
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const token = signAuthToken({ userId: user.id, cabinetId: user.cabinetId, role: user.role });

  res.cookie("aurore_session", token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.json({ id: user.id, nom: user.nom, email: user.email, role: user.role });
});

authRouter.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("aurore_session");
  return res.json({ ok: true });
});

authRouter.get("/api/auth/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: {
      id: true,
      nom: true,
      email: true,
      role: true,
      cabinetId: true,
      signatureUrl: true,
      partageSignatureActif: true,
      recoitVeille: true,
      telephone: true,
      adresse: true,
      dateArrivee: true,
      modulesDesactives: true,
      responsable: { select: { nom: true, signatureUrl: true } },
      cabinet: { select: { modulesDesactives: true } },
    },
  });
  if (!user) {
    return res.status(404).json({ error: "Utilisateur introuvable" });
  }

  const peutUtiliserSignatureResponsable =
    user.role === "collaborateur" && user.partageSignatureActif && !!user.responsable?.signatureUrl;

  return res.json({
    ...user,
    responsable: user.responsable ? { nom: user.responsable.nom } : null,
    peutUtiliserSignatureResponsable,
    // Union cabinet + individuel : le frontend (layout.js, filtre des
    // NAV_ITEMS) n'a besoin de connaitre qu'une seule liste "modules
    // indisponibles", jamais l'origine de la restriction - le reglage
    // titulaire (User.modulesDesactives) ne fait jamais reapparaitre un
    // module deja retire par la plateforme, uniquement en restreindre en
    // plus (voir middleware/roles.ts, requireModule, pour la meme regle
    // cote serveur).
    modulesDesactives: [...new Set([...user.cabinet.modulesDesactives, ...user.modulesDesactives])],
    cabinet: undefined,
  });
});
