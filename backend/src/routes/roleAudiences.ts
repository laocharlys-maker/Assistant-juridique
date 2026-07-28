import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { getAccessibleAvocatIds } from "../services/access";
import { callN8nWebhook } from "../services/n8n";
import { buildRoleSemainePdf, buildRoleSemaineWord } from "../services/roleSemaineExport";

export const roleAudiencesRouter = Router();

function peutVoirTouLeCabinet(role: string | undefined): boolean {
  return role === "titulaire" || role === "avocat";
}

// Lundi de la semaine contenant la date donnee (ou aujourd'hui par defaut).
function lundiDeLaSemaine(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const jour = d.getUTCDay(); // 0 = dimanche, 1 = lundi, ...
  const decalage = jour === 0 ? -6 : 1 - jour;
  d.setUTCDate(d.getUTCDate() + decalage);
  return d;
}

// Calcule la periode [debut, fin[ demandee - une semaine (comportement
// historique) ou un mois entier (vue calendrier mensuel de la page
// Audiences programmees), selon le parametre "periode".
function calculerPeriode(req: { query: { debut?: unknown; periode?: unknown } }): { debut: Date; fin: Date } {
  const debutParam = typeof req.query.debut === "string" ? new Date(req.query.debut) : new Date();
  const base = Number.isNaN(debutParam.getTime()) ? new Date() : debutParam;

  if (req.query.periode === "mois") {
    const debut = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1));
    const fin = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1));
    return { debut, fin };
  }

  const debut = lundiDeLaSemaine(base);
  const fin = new Date(debut);
  fin.setUTCDate(fin.getUTCDate() + 7);
  return { debut, fin };
}

// Role de la semaine : audiences a venir, saisies manuellement par le
// cabinet (le format recu du greffe/tribunal varie trop pour etre extrait
// automatiquement de facon fiable). Vue centrale pour preparer les
// audiences a temps, le role etant generalement communique ~10 jours avant
// la semaine concernee.
roleAudiencesRouter.get("/api/role-audiences", requireAuth, async (req, res) => {
  const { auth } = req;

  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";
  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth!) : null;

  const { debut, fin } = calculerPeriode(req);

  const audiences = await prisma.roleAudience.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      dateAudience: { gte: debut, lt: fin },
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true } },
      creePar: { select: { nom: true } },
    },
    orderBy: { dateAudience: "asc" },
  });

  return res.json({ scope, debut: debut.toISOString(), fin: fin.toISOString(), audiences });
});

// Periode de la semaine SUR-prochaine (et non la semaine suivante, deja
// visible depuis un moment via le calendrier) - l'idee est de laisser toute
// la semaine a venir a l'avocat pour preparer ces audiences-la. Uniquement
// pertinent du jeudi au dimanche : avant, la semaine sur-prochaine n'est pas
// encore consideree comme "a preparer des maintenant" ; le lundi au
// mercredi, on est deja dans la semaine qui la precede immediatement, donc
// plus vraiment en amont.
function calculerSemaineSurProchaine(): { debut: Date; fin: Date; disponible: boolean } {
  const maintenant = new Date();
  const jourSemaine = maintenant.getUTCDay(); // 0 = dimanche ... 6 = samedi
  // TEMPORAIRE - filtre jour-de-semaine neutralise pour permettre un test
  // immediat, a retablir (jourSemaine === 0 || jourSemaine >= 4) une fois
  // le test termine.
  void jourSemaine;
  const disponible = true;

  const debut = lundiDeLaSemaine(maintenant);
  debut.setUTCDate(debut.getUTCDate() + 14);
  const fin = new Date(debut);
  fin.setUTCDate(fin.getUTCDate() + 5); // lundi a vendredi inclus

  return { debut, fin, disponible };
}

async function chargerAudiencesSemaineSurProchaine(auth: NonNullable<Express.Request["auth"]>, scope: "mine" | "cabinet") {
  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth) : null;
  const { debut, fin, disponible } = calculerSemaineSurProchaine();

  if (!disponible) {
    return { disponible: false as const, debut, fin, audiences: [] };
  }

  const audiences = await prisma.roleAudience.findMany({
    where: {
      cabinetId: auth.cabinetId,
      dateAudience: { gte: debut, lt: fin },
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true } },
      creePar: { select: { nom: true } },
    },
    orderBy: { dateAudience: "asc" },
  });

  return { disponible: true as const, debut, fin, audiences };
}

roleAudiencesRouter.get("/api/role-audiences/semaine-sur-prochaine", requireAuth, async (req, res) => {
  const { auth } = req;
  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";

  const { disponible, debut, fin, audiences } = await chargerAudiencesSemaineSurProchaine(auth!, scope);

  return res.json({
    disponible,
    scope,
    debut: debut.toISOString(),
    fin: fin.toISOString(),
    audiences,
  });
});

async function exportSemaineSurProchaine(req: Request, res: Response, format: "pdf" | "word") {
  const { auth } = req;
  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";

  const { disponible, debut, fin, audiences } = await chargerAudiencesSemaineSurProchaine(auth!, scope);
  if (!disponible || audiences.length === 0) {
    return res.status(404).json({ error: "Aucune audience à exporter pour la semaine sur-prochaine." });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: auth!.cabinetId } });
  const exportInput = { cabinetNom: cabinet?.nom ?? "", cabinetAdresse: cabinet?.adresse ?? null, debut, fin, audiences };

  if (format === "pdf") {
    const buffer = await buildRoleSemainePdf(exportInput);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="role-de-la-semaine.pdf"');
    return res.send(buffer);
  }

  const buffer = await buildRoleSemaineWord(exportInput);
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  res.setHeader("Content-Disposition", 'attachment; filename="role-de-la-semaine.docx"');
  return res.send(buffer);
}

roleAudiencesRouter.get("/api/role-audiences/semaine-sur-prochaine/pdf", requireAuth, (req, res) =>
  exportSemaineSurProchaine(req, res, "pdf")
);
roleAudiencesRouter.get("/api/role-audiences/semaine-sur-prochaine/word", requireAuth, (req, res) =>
  exportSemaineSurProchaine(req, res, "word")
);

// Suggestions : dossiers dont le dernier compte-rendu annonce une
// "prochaine audience" tombant dans la semaine consultee, et qui n'ont pas
// encore ete ajoutes au role. On ne pre-remplit que ce qu'on sait avec
// certitude (dossier, date) - le reste (juridiction, parties, qualite,
// objet, diligences) n'est pas capture de facon structuree dans le
// compte-rendu et reste a completer manuellement.
roleAudiencesRouter.get("/api/role-audiences/suggestions", requireAuth, async (req, res) => {
  const { auth } = req;

  const { debut, fin } = calculerPeriode(req);

  const accessibleAvocatIds = peutVoirTouLeCabinet(auth!.role) ? null : await getAccessibleAvocatIds(auth!);

  const actions = await prisma.action.findMany({
    where: {
      typeAction: "notes",
      prochaineAudience: { gte: debut, lt: fin },
      ignorerSuggestionRole: false,
      dossier: {
        cabinetId: auth!.cabinetId,
        ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
      },
    },
    orderBy: { createdAt: "desc" },
    include: { dossier: { select: { id: true, numeroDossier: true, nomAffaire: true, nomClient: true } } },
  });

  const parDossier = new Map<string, (typeof actions)[number]>();
  for (const a of actions) {
    if (!parDossier.has(a.dossierId)) parDossier.set(a.dossierId, a);
  }

  const dejaAjoutees = await prisma.roleAudience.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      dossierId: { in: [...parDossier.keys()] },
      dateAudience: { gte: debut, lt: fin },
    },
    select: { dossierId: true },
  });
  const dossierIdsDejaAjoutes = new Set(dejaAjoutees.map((r) => r.dossierId).filter((id): id is string => !!id));

  const suggestions = [...parDossier.values()]
    .filter((a) => !dossierIdsDejaAjoutes.has(a.dossierId))
    .map((a) => ({
      actionId: a.id,
      dossierId: a.dossierId,
      dossier: a.dossier,
      prochaineAudience: a.prochaineAudience,
      piecesPrevoir: a.piecesPrevoir,
    }));

  return res.json({ suggestions });
});

// Ecarte une suggestion (le cabinet a juge qu'elle n'a pas lieu d'etre
// reprise au role - deja traitee autrement, information obsolete...).
// Persistant pour ne pas la faire revenir a chaque chargement de la page.
roleAudiencesRouter.post("/api/role-audiences/suggestions/:actionId/ignorer", requireAuth, async (req, res) => {
  const action = await prisma.action.findFirst({
    where: { id: req.params.actionId, dossier: { cabinetId: req.auth!.cabinetId } },
  });
  if (!action) {
    return res.status(404).json({ error: "Suggestion introuvable" });
  }

  await prisma.action.update({
    where: { id: action.id },
    data: { ignorerSuggestionRole: true },
  });

  return res.json({ ok: true });
});

const createSchema = z.object({
  dateAudience: z.string().min(1),
  juridiction: z.string().min(1),
  chambre: z.string().optional(),
  procedureNumero: z.string().optional(),
  parties: z.string().min(1),
  qualiteProcedurale: z.string().optional(),
  objetProcedure: z.string().optional(),
  dernierMotif: z.string().optional(),
  diligences: z.string().optional(),
  dossierId: z.string().uuid().optional(),
  creerRappelCalendar: z.boolean().optional().default(false),
});

roleAudiencesRouter.post("/api/role-audiences", requireAuth, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const dateAudience = new Date(parsed.data.dateAudience);
  if (Number.isNaN(dateAudience.getTime())) {
    return res.status(400).json({ error: "Date d'audience invalide" });
  }
  // Une audience ne peut jamais etre programmee dans le passe - erreur de
  // saisie la plus frequente, a bloquer plutot qu'a laisser enregistrer.
  if (dateAudience.getTime() < Date.now()) {
    return res.status(400).json({ error: "La date de l'audience ne peut pas être dans le passé. Vérifie la date saisie." });
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

  if (parsed.data.creerRappelCalendar) {
    await callN8nWebhook("creer-rappel-delai", {
      titre: `Audience : ${parsed.data.parties}${dossier ? ` — ${dossier.nomAffaire}` : ""}`,
      description: `${parsed.data.juridiction}${parsed.data.chambre ? ` — ${parsed.data.chambre}` : ""}${parsed.data.objetProcedure ? `\nObjet : ${parsed.data.objetProcedure}` : ""}`,
      dateLimite: dateAudience.toISOString(),
    });
  }

  const audience = await prisma.roleAudience.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: dossier?.id,
      dateAudience,
      juridiction: parsed.data.juridiction,
      chambre: parsed.data.chambre,
      procedureNumero: parsed.data.procedureNumero,
      parties: parsed.data.parties,
      qualiteProcedurale: parsed.data.qualiteProcedurale,
      objetProcedure: parsed.data.objetProcedure,
      dernierMotif: parsed.data.dernierMotif,
      diligences: parsed.data.diligences,
      createdBy: req.auth!.userId,
    },
    include: {
      dossier: { select: { numeroDossier: true, nomAffaire: true } },
      creePar: { select: { nom: true } },
    },
  });

  return res.status(201).json(audience);
});

const updateSchema = z.object({
  statut: z.enum(["a_preparer", "pret", "traite"]).optional(),
  juridiction: z.string().min(1).optional(),
  chambre: z.string().optional(),
  procedureNumero: z.string().optional(),
  parties: z.string().min(1).optional(),
  qualiteProcedurale: z.string().optional(),
  objetProcedure: z.string().optional(),
  dernierMotif: z.string().optional(),
  diligences: z.string().optional(),
});

roleAudiencesRouter.patch("/api/role-audiences/:id", requireAuth, async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }

  const existing = await prisma.roleAudience.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!existing) {
    return res.status(404).json({ error: "Audience introuvable" });
  }

  const updated = await prisma.roleAudience.update({
    where: { id: existing.id },
    data: parsed.data,
  });
  return res.json(updated);
});

roleAudiencesRouter.delete("/api/role-audiences/:id", requireAuth, async (req, res) => {
  await prisma.roleAudience
    .deleteMany({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } })
    .catch(() => null);
  return res.json({ ok: true });
});
