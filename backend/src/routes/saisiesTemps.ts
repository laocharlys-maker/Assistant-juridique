import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { SaisieTemps } from "@prisma/client";
import {
  agregerParCollaborateur,
  agregerParDossier,
  buildFeuilleTempsPdf,
  SaisiePourAgregation,
} from "../services/feuillesTemps";

export const saisiesTempsRouter = Router();

// Meme module que la facturation (le suivi du temps existe avant tout pour
// alimenter "Facturer ce dossier") - peut etre desactive par la plateforme
// pour un cabinet dont la formule ne l'inclut pas, comme /api/factures*.
saisiesTempsRouter.use("/api/saisies-temps", requireAuth, requireModule("facturation"));

function peutVoirTouLeCabinet(role: string | undefined): boolean {
  return role === "titulaire" || role === "avocat";
}

/**
 * Lot 14 - arrondit une duree en millisecondes a la minute la plus proche
 * (contrainte du prompt : "arrondir les durees de facon coherente et
 * documentee") - utilise UNIQUEMENT au moment ou un chronometre est
 * arrete (jamais recalcule ensuite, jamais utilise par
 * services/feuillesTemps.ts qui se contente de sommer des dureeMinutes deja
 * arrondies).
 */
function arrondirMinutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60000));
}

function avecMontant<T extends { dureeMinutes: number | null; tauxHoraireApplique: number | null }>(
  saisie: T
): T & { montant: number | null } {
  const montant =
    saisie.dureeMinutes !== null && saisie.tauxHoraireApplique !== null
      ? Math.round((saisie.dureeMinutes / 60) * saisie.tauxHoraireApplique)
      : null;
  return { ...saisie, montant };
}

const INCLUDE_STANDARD = {
  dossier: { select: { id: true, numeroDossier: true, nomAffaire: true } },
  action: { select: { id: true, typeAction: true, nomDocument: true } },
  user: { select: { id: true, nom: true } },
} as const;

/** Verifie que le demandeur peut consulter/gerer les saisies de CET
 * utilisateur cible - soit lui-meme, soit un avocat/titulaire supervisant
 * directement ce collaborateur (meme regle que GET /api/dossiers?membre=,
 * dossiers.ts), soit le titulaire (voit tout le cabinet). Un collaborateur
 * ne voit et ne modifie JAMAIS les saisies d'un collegue (contrainte
 * explicite du prompt). */
async function peutAccederAuxSaisiesDe(
  auth: { userId: string; role: string; cabinetId: string },
  cibleUserId: string
): Promise<boolean> {
  if (cibleUserId === auth.userId) return true;
  if (auth.role === "titulaire") {
    const cible = await prisma.user.findFirst({ where: { id: cibleUserId, cabinetId: auth.cabinetId } });
    return !!cible;
  }
  if (auth.role === "avocat") {
    const cible = await prisma.user.findFirst({ where: { id: cibleUserId, cabinetId: auth.cabinetId } });
    return !!cible && cible.responsableId === auth.userId;
  }
  return false;
}

// ---------- Chronometre ----------

const demarrerSchema = z.object({
  dossierId: z.string().uuid(),
  actionId: z.string().uuid().optional(),
  description: z.string().optional(),
});

saisiesTempsRouter.post("/api/saisies-temps/demarrer", requireAuth, async (req, res) => {
  const parsed = demarrerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  // Un seul chronometre actif a la fois (contrainte du prompt), EN COURS ou
  // EN PAUSE (arreteA null dans les deux cas - voir le commentaire sur
  // SaisieTemps.demarreA, schema.prisma) - bloque avec un message clair
  // identifiant le dossier concerne, plutot que d'arreter automatiquement
  // le precedent (risque de perte de temps non voulue sur le mauvais
  // dossier - voir README-LOT14.md).
  const actif = await prisma.saisieTemps.findFirst({
    where: { userId: req.auth!.userId, arreteA: null },
    include: { dossier: { select: { numeroDossier: true, nomAffaire: true } } },
  });
  if (actif) {
    const etat = actif.demarreA ? "en cours" : "en pause";
    return res.status(409).json({
      error: `Un chronomètre est déjà ${etat} sur le dossier ${actif.dossier.numeroDossier} — ${actif.dossier.nomAffaire}. Arrête-le avant d'en démarrer un autre.`,
    });
  }

  const dossier = await prisma.dossier.findFirst({
    where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
  });
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }
  if (parsed.data.actionId) {
    const action = await prisma.action.findFirst({
      where: { id: parsed.data.actionId, dossierId: dossier.id },
    });
    if (!action) {
      return res.status(404).json({ error: "Action introuvable dans ce dossier" });
    }
  }

  const utilisateur = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { tauxHoraireDefaut: true },
  });

  const maintenant = new Date();
  const saisie = await prisma.saisieTemps.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: dossier.id,
      actionId: parsed.data.actionId,
      userId: req.auth!.userId,
      source: "chrono",
      date: maintenant,
      demarreA: maintenant,
      description: parsed.data.description,
      // Snapshot immediat (voir README-LOT14.md) - jamais recalcule si le
      // taux horaire de l'utilisateur change ensuite, y compris pendant que
      // ce chronometre tourne encore.
      tauxHoraireApplique: utilisateur?.tauxHoraireDefaut ?? null,
    },
    include: INCLUDE_STANDARD,
  });

  return res.status(201).json(avecMontant(saisie));
});

// Met en pause un chronometre EN COURS : accumule la duree du segment qui
// vient de se terminer dans dureeAccumuleeSecondes, puis vide demarreA
// (voir le commentaire sur SaisieTemps.demarreA, schema.prisma) - ne cree
// JAMAIS une nouvelle SaisieTemps, ne cloture jamais dureeMinutes (reserve
// a l'arret definitif, POST .../arreter ci-dessous).
saisiesTempsRouter.post("/api/saisies-temps/:id/pause", requireAuth, async (req, res) => {
  const saisie = await prisma.saisieTemps.findFirst({
    where: { id: req.params.id, userId: req.auth!.userId },
  });
  if (!saisie) {
    return res.status(404).json({ error: "Saisie de temps introuvable" });
  }
  if (!saisie.demarreA || saisie.arreteA) {
    return res.status(409).json({ error: "Ce chronomètre n'est pas en cours (déjà en pause ou arrêté)." });
  }

  const segmentSecondes = Math.max(0, Math.round((Date.now() - saisie.demarreA.getTime()) / 1000));

  const updated = await prisma.saisieTemps.update({
    where: { id: saisie.id },
    data: { demarreA: null, dureeAccumuleeSecondes: saisie.dureeAccumuleeSecondes + segmentSecondes },
    include: INCLUDE_STANDARD,
  });

  return res.json(avecMontant(updated));
});

// Reprend un chronometre EN PAUSE : redemarre un nouveau segment (demarreA)
// sans toucher a la duree deja accumulee. Meme garde-fou "un seul actif a
// la fois" que POST .../demarrer (defensif : ne devrait normalement jamais
// se declencher, ce chronometre etant deja celui compte comme "actif").
saisiesTempsRouter.post("/api/saisies-temps/:id/reprendre", requireAuth, async (req, res) => {
  const saisie = await prisma.saisieTemps.findFirst({
    where: { id: req.params.id, userId: req.auth!.userId },
  });
  if (!saisie) {
    return res.status(404).json({ error: "Saisie de temps introuvable" });
  }
  if (saisie.demarreA || saisie.arreteA) {
    return res.status(409).json({ error: "Ce chronomètre n'est pas en pause." });
  }

  const autreActif = await prisma.saisieTemps.findFirst({
    where: { userId: req.auth!.userId, arreteA: null, id: { not: saisie.id } },
  });
  if (autreActif) {
    return res.status(409).json({ error: "Un autre chronomètre est déjà en cours ou en pause. Arrête-le avant de reprendre celui-ci." });
  }

  const updated = await prisma.saisieTemps.update({
    where: { id: saisie.id },
    data: { demarreA: new Date() },
    include: INCLUDE_STANDARD,
  });

  return res.json(avecMontant(updated));
});

saisiesTempsRouter.post("/api/saisies-temps/:id/arreter", requireAuth, async (req, res) => {
  const saisie = await prisma.saisieTemps.findFirst({
    where: { id: req.params.id, userId: req.auth!.userId },
  });
  if (!saisie) {
    return res.status(404).json({ error: "Saisie de temps introuvable" });
  }
  if (saisie.arreteA) {
    return res.status(409).json({ error: "Ce chronomètre n'est pas actif." });
  }

  const arreteA = new Date();
  // Segment en cours (0 si le chronometre etait en pause, demarreA deja
  // null) + tous les segments precedents deja accumules lors d'une pause
  // anterieure - jamais recalcule ensuite, voir arrondirMinutes ci-dessus.
  const segmentEnCoursMs = saisie.demarreA ? arreteA.getTime() - saisie.demarreA.getTime() : 0;
  const dureeMinutes = arrondirMinutes(saisie.dureeAccumuleeSecondes * 1000 + segmentEnCoursMs);

  const updated = await prisma.saisieTemps.update({
    where: { id: saisie.id },
    data: { arreteA, dureeMinutes },
    include: INCLUDE_STANDARD,
  });

  return res.json(avecMontant(updated));
});

// Chronometre actif de l'utilisateur courant (ou null), EN COURS ou EN
// PAUSE - interroge au chargement de chaque page pour restaurer l'etat du
// widget cote frontend : c'est ce qui garantit la persistance (contrainte
// du prompt) - jamais stocke uniquement en memoire navigateur, toujours
// relu depuis le serveur.
saisiesTempsRouter.get("/api/saisies-temps/actif", requireAuth, async (req, res) => {
  const saisie = await prisma.saisieTemps.findFirst({
    where: { userId: req.auth!.userId, arreteA: null },
    include: INCLUDE_STANDARD,
  });
  return res.json(saisie ? avecMontant(saisie) : null);
});

// ---------- Saisie manuelle ----------

const creerManuelleSchema = z.object({
  dossierId: z.string().uuid(),
  actionId: z.string().uuid().optional(),
  date: z.string().min(1),
  dureeMinutes: z.number().int().positive("La durée doit être supérieure à 0"),
  description: z.string().optional(),
});

saisiesTempsRouter.post("/api/saisies-temps", requireAuth, async (req, res) => {
  const parsed = creerManuelleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const date = new Date(parsed.data.date);
  if (Number.isNaN(date.getTime())) {
    return res.status(400).json({ error: "Date invalide" });
  }

  const dossier = await prisma.dossier.findFirst({
    where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
  });
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }
  if (parsed.data.actionId) {
    const action = await prisma.action.findFirst({
      where: { id: parsed.data.actionId, dossierId: dossier.id },
    });
    if (!action) {
      return res.status(404).json({ error: "Action introuvable dans ce dossier" });
    }
  }

  const utilisateur = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { tauxHoraireDefaut: true },
  });

  const saisie = await prisma.saisieTemps.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: dossier.id,
      actionId: parsed.data.actionId,
      userId: req.auth!.userId,
      source: "manuel",
      date,
      dureeMinutes: parsed.data.dureeMinutes,
      description: parsed.data.description,
      tauxHoraireApplique: utilisateur?.tauxHoraireDefaut ?? null,
    },
    include: INCLUDE_STANDARD,
  });

  return res.status(201).json(avecMontant(saisie));
});

const modifierSchema = z.object({
  description: z.string().optional(),
  dureeMinutes: z.number().int().positive().optional(),
  date: z.string().optional(),
});

saisiesTempsRouter.patch("/api/saisies-temps/:id", requireAuth, async (req, res) => {
  const saisie = await prisma.saisieTemps.findFirst({
    where: { id: req.params.id, userId: req.auth!.userId },
  });
  if (!saisie) {
    return res.status(404).json({ error: "Saisie de temps introuvable" });
  }
  if (saisie.factureId) {
    return res.status(409).json({ error: "Cette saisie a déjà été facturée : elle ne peut plus être modifiée." });
  }
  if (saisie.demarreA && !saisie.arreteA) {
    return res.status(409).json({ error: "Ce chronomètre est en cours : arrête-le avant de modifier la saisie." });
  }

  const parsed = modifierSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  let date: Date | undefined;
  if (parsed.data.date !== undefined) {
    date = new Date(parsed.data.date);
    if (Number.isNaN(date.getTime())) {
      return res.status(400).json({ error: "Date invalide" });
    }
  }

  const updated = await prisma.saisieTemps.update({
    where: { id: saisie.id },
    data: {
      description: parsed.data.description,
      dureeMinutes: parsed.data.dureeMinutes,
      date,
    },
    include: INCLUDE_STANDARD,
  });

  return res.json(avecMontant(updated));
});

saisiesTempsRouter.delete("/api/saisies-temps/:id", requireAuth, async (req, res) => {
  const saisie = await prisma.saisieTemps.findFirst({
    where: { id: req.params.id, userId: req.auth!.userId },
  });
  if (!saisie) {
    return res.status(404).json({ error: "Saisie de temps introuvable" });
  }
  if (saisie.factureId) {
    return res.status(409).json({ error: "Cette saisie a déjà été facturée : elle ne peut plus être supprimée." });
  }

  await prisma.saisieTemps.delete({ where: { id: saisie.id } });
  return res.json({ ok: true });
});

// ---------- Consultation ----------

function periodeDepuisQuery(req: { query: { debut?: unknown; fin?: unknown } }): { debut?: Date; fin?: Date } {
  const debut = typeof req.query.debut === "string" ? new Date(req.query.debut) : undefined;
  const fin = typeof req.query.fin === "string" ? new Date(req.query.fin) : undefined;
  return {
    debut: debut && !Number.isNaN(debut.getTime()) ? debut : undefined,
    fin: fin && !Number.isNaN(fin.getTime()) ? fin : undefined,
  };
}

// Mes propres saisies (toujours - jamais celles d'un collegue ici, voir
// GET /api/saisies-temps/equipe pour la vue avocat/titulaire).
saisiesTempsRouter.get("/api/saisies-temps", requireAuth, async (req, res) => {
  const dossierId = typeof req.query.dossierId === "string" ? req.query.dossierId : undefined;
  const { debut, fin } = periodeDepuisQuery(req);

  const saisies = await prisma.saisieTemps.findMany({
    where: {
      userId: req.auth!.userId,
      ...(dossierId ? { dossierId } : {}),
      ...(debut || fin ? { date: { ...(debut ? { gte: debut } : {}), ...(fin ? { lt: fin } : {}) } } : {}),
    },
    include: INCLUDE_STANDARD,
    orderBy: { date: "desc" },
  });

  return res.json(saisies.map(avecMontant));
});

// Vue "equipe" (avocat/titulaire) : saisies d'un collaborateur precis
// (userId, doit etre soi-meme ou un collaborateur supervise directement),
// ou de tous les collaborateurs accessibles si userId omis - utilisee par
// les feuilles de temps agregees.
saisiesTempsRouter.get("/api/saisies-temps/equipe", requireAuth, async (req, res) => {
  if (!peutVoirTouLeCabinet(req.auth!.role)) {
    return res.status(403).json({ error: "Réservé aux avocats du cabinet" });
  }

  const dossierId = typeof req.query.dossierId === "string" ? req.query.dossierId : undefined;
  const userIdParam = typeof req.query.userId === "string" ? req.query.userId : undefined;
  const { debut, fin } = periodeDepuisQuery(req);

  let userIds: string[] | undefined;
  if (userIdParam) {
    const autorise = await peutAccederAuxSaisiesDe(req.auth!, userIdParam);
    if (!autorise) {
      return res.status(403).json({ error: "Tu ne supervises pas directement ce collaborateur." });
    }
    userIds = [userIdParam];
  } else if (req.auth!.role === "avocat") {
    const collaborateurs = await prisma.user.findMany({
      where: { cabinetId: req.auth!.cabinetId, responsableId: req.auth!.userId },
      select: { id: true },
    });
    userIds = [req.auth!.userId, ...collaborateurs.map((c) => c.id)];
  }
  // titulaire sans userId precise : pas de filtre userIds -> tout le cabinet.

  const saisies = await prisma.saisieTemps.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      ...(userIds ? { userId: { in: userIds } } : {}),
      ...(dossierId ? { dossierId } : {}),
      ...(debut || fin ? { date: { ...(debut ? { gte: debut } : {}), ...(fin ? { lt: fin } : {}) } } : {}),
    },
    include: INCLUDE_STANDARD,
    orderBy: { date: "desc" },
  });

  return res.json(saisies.map(avecMontant));
});

// ---------- Feuilles de temps agregees ----------

function versSaisiePourAgregation(saisie: {
  userId: string;
  user: { nom: string };
  dossierId: string;
  dossier: { numeroDossier: string; nomAffaire: string };
  dureeMinutes: number | null;
  tauxHoraireApplique: number | null;
}): SaisiePourAgregation | null {
  // Un chronometre encore actif (dureeMinutes null) n'a pas de duree
  // definitive - exclu de toute agregation/facturation tant qu'il n'est
  // pas arrete (voir routes/saisiesTemps.ts, POST .../arreter).
  if (saisie.dureeMinutes === null) return null;
  return {
    userId: saisie.userId,
    userNom: saisie.user.nom,
    dossierId: saisie.dossierId,
    dossierLabel: `${saisie.dossier.numeroDossier} — ${saisie.dossier.nomAffaire}`,
    dureeMinutes: saisie.dureeMinutes,
    tauxHoraireApplique: saisie.tauxHoraireApplique,
  };
}

// Vue agregee (par collaborateur ou par dossier), JSON ou PDF - meme
// perimetre d'acces que /equipe pour un avocat/titulaire ; un collaborateur
// ne peut demander que sa propre feuille (jamais celle d'un collegue).
saisiesTempsRouter.get("/api/saisies-temps/feuille", requireAuth, async (req, res) => {
  const groupBy = req.query.groupBy === "dossier" ? "dossier" : "collaborateur";
  const dossierId = typeof req.query.dossierId === "string" ? req.query.dossierId : undefined;
  const userIdParam = typeof req.query.userId === "string" ? req.query.userId : undefined;
  const format = req.query.format === "pdf" ? "pdf" : "json";
  const { debut, fin } = periodeDepuisQuery(req);

  let userIds: string[] | undefined;
  if (!peutVoirTouLeCabinet(req.auth!.role)) {
    if (userIdParam && userIdParam !== req.auth!.userId) {
      return res.status(403).json({ error: "Tu ne peux consulter que ta propre feuille de temps." });
    }
    userIds = [req.auth!.userId];
  } else if (userIdParam) {
    const autorise = await peutAccederAuxSaisiesDe(req.auth!, userIdParam);
    if (!autorise) {
      return res.status(403).json({ error: "Tu ne supervises pas directement ce collaborateur." });
    }
    userIds = [userIdParam];
  } else if (req.auth!.role === "avocat") {
    const collaborateurs = await prisma.user.findMany({
      where: { cabinetId: req.auth!.cabinetId, responsableId: req.auth!.userId },
      select: { id: true },
    });
    userIds = [req.auth!.userId, ...collaborateurs.map((c) => c.id)];
  }

  const saisiesBrutes = await prisma.saisieTemps.findMany({
    where: {
      cabinetId: req.auth!.cabinetId,
      ...(userIds ? { userId: { in: userIds } } : {}),
      ...(dossierId ? { dossierId } : {}),
      ...(debut || fin ? { date: { ...(debut ? { gte: debut } : {}), ...(fin ? { lt: fin } : {}) } } : {}),
    },
    include: { user: { select: { nom: true } }, dossier: { select: { numeroDossier: true, nomAffaire: true } } },
  });

  const saisies = saisiesBrutes.map(versSaisiePourAgregation).filter((s): s is SaisiePourAgregation => s !== null);
  const lignes = groupBy === "dossier" ? agregerParDossier(saisies) : agregerParCollaborateur(saisies);

  if (format === "json") {
    return res.json({ groupBy, lignes });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: req.auth!.cabinetId } });
  const intitulePeriode =
    debut && fin
      ? `du ${debut.toLocaleDateString("fr-FR")} au ${new Date(fin.getTime() - 1).toLocaleDateString("fr-FR")}`
      : "période complète";
  const buffer = await buildFeuilleTempsPdf({
    cabinetNom: cabinet?.nom ?? "",
    titre: `Feuille de temps — ${groupBy === "dossier" ? "par dossier" : "par collaborateur"}`,
    sousTitre: intitulePeriode,
    lignes,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="feuille-de-temps.pdf"');
  return res.send(buffer);
});

export type { SaisieTemps };
export { avecMontant, peutAccederAuxSaisiesDe, arrondirMinutes };
