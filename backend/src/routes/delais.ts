import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin, requireModule } from "../middleware/roles";
import { computeDeadline } from "../services/delais";
import { callN8nWebhook } from "../services/n8n";

export const delaisRouter = Router();

// Module payant : peut etre desactive par la plateforme pour un cabinet
// dont la formule ne l'inclut pas. Chemins explicites obligatoires : sans
// eux, ce middleware s'appliquerait a TOUTES les requetes de l'app (ce
// routeur est monte sans prefixe sur app), pas seulement aux routes ici.
delaisRouter.use(["/api/delais-types", "/api/delais"], requireAuth, requireModule("delais"));

delaisRouter.get("/api/delais-types", requireAuth, async (req, res) => {
  const includeInactifs = req.query.all === "1" && req.auth!.role === "titulaire";
  const types = await prisma.delaiType.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      ...(includeInactifs ? {} : { actif: true }),
    },
    orderBy: { nom: "asc" },
  });
  return res.json(types);
});

const createDelaiTypeSchema = z.object({
  nom: z.string().min(1),
  nombreUnites: z.number().int().positive(),
  unite: z.enum(["jours", "mois"]),
  joursOuvresUniquement: z.boolean().optional().default(true),
  texteReference: z.string().min(1, "Le texte de loi de référence est obligatoire"),
});

delaisRouter.post("/api/delais-types", requireAuth, requireAdmin, async (req, res) => {
  const parsed = createDelaiTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const delaiType = await prisma.delaiType.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      nom: parsed.data.nom,
      nombreUnites: parsed.data.nombreUnites,
      unite: parsed.data.unite,
      joursOuvresUniquement: parsed.data.joursOuvresUniquement,
      texteReference: parsed.data.texteReference,
      createdById: req.auth!.userId,
    },
  });

  return res.status(201).json(delaiType);
});

const updateDelaiTypeSchema = createDelaiTypeSchema.partial().extend({
  actif: z.boolean().optional(),
});

delaisRouter.patch("/api/delais-types/:id", requireAuth, requireAdmin, async (req, res) => {
  const parsed = updateDelaiTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const existing = await prisma.delaiType.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!existing) {
    return res.status(404).json({ error: "Type de délai introuvable" });
  }

  const updated = await prisma.delaiType.update({
    where: { id: existing.id },
    data: parsed.data,
  });
  return res.json(updated);
});

delaisRouter.delete("/api/delais-types/:id", requireAuth, requireAdmin, async (req, res) => {
  await prisma.delaiType
    .deleteMany({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } })
    .catch(() => null);
  return res.json({ ok: true });
});

const calculerSchema = z.object({
  delaiTypeId: z.string().uuid(),
  dateDepart: z.string().min(1),
  dossierId: z.string().uuid().optional(),
  creerRappelCalendar: z.boolean().optional().default(false),
});

delaisRouter.post("/api/delais/calculer", requireAuth, async (req, res) => {
  const parsed = calculerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const delaiType = await prisma.delaiType.findFirst({
    where: { id: parsed.data.delaiTypeId, cabinetId: req.auth!.cabinetId, actif: true },
  });
  if (!delaiType) {
    return res.status(404).json({ error: "Type de délai introuvable ou inactif" });
  }

  const dateDepart = new Date(parsed.data.dateDepart);
  if (Number.isNaN(dateDepart.getTime())) {
    return res.status(400).json({ error: "Date de départ invalide" });
  }

  let dossier = null;
  if (parsed.data.dossierId) {
    dossier = await prisma.dossier.findFirst({
      where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
    });
    if (!dossier) {
      return res.status(404).json({ error: "Dossier introuvable" });
    }
  }

  const dateLimite = computeDeadline(
    dateDepart,
    delaiType.nombreUnites,
    delaiType.unite,
    delaiType.joursOuvresUniquement
  );

  let rappelCalendar = false;
  if (parsed.data.creerRappelCalendar) {
    const n8nResult = await callN8nWebhook("creer-rappel-delai", {
      titre: `Échéance : ${delaiType.nom}${dossier ? ` — ${dossier.nomAffaire}` : ""}`,
      description: `Délai "${delaiType.nom}" (${delaiType.texteReference}). Date de départ : ${dateDepart.toISOString().slice(0, 10)}.`,
      dateLimite: dateLimite.toISOString(),
    });
    rappelCalendar = n8nResult.ok;
  }

  const calcul = await prisma.delaiCalcul.create({
    data: {
      delaiTypeId: delaiType.id,
      dossierId: dossier?.id,
      dateDepart,
      dateLimite,
      rappelCalendar,
      createdById: req.auth!.userId,
    },
    include: { delaiType: true },
  });

  return res.status(201).json(calcul);
});

delaisRouter.get("/api/delais/historique", requireAuth, async (req, res) => {
  const dossierId = typeof req.query.dossierId === "string" ? req.query.dossierId : undefined;
  const calculs = await prisma.delaiCalcul.findMany({
    where: {
      createdBy: { cabinetId: req.auth!.cabinetId },
      ...(dossierId ? { dossierId } : {}),
    },
    include: { delaiType: true, dossier: true, createdBy: { select: { nom: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return res.json(calculs);
});
