import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { getAccessibleAvocatIds } from "../services/access";
import { buildRoleSemainePdf, buildRoleSemaineWord } from "../services/roleSemaineExport";
import { syncEvenementDepuisRoleAudience, supprimerEvenementDepuisRoleAudience } from "../services/evenementSync";
import { TYPES_EVENEMENT } from "./evenements";

export const roleAudiencesRouter = Router();

function peutVoirTouLeCabinet(role: string | undefined): boolean {
  return role === "titulaire" || role === "avocat";
}

// Libelles francais des types d'Evenement (hors "audience", traitee a part
// via RoleAudience - voir plus bas) pour la section "Autres evenements" du
// Role de la semaine (JSON + export PDF/Word).
const LIBELLES_TYPE_EVENEMENT: Record<string, string> = {
  rdv: "RDV",
  appel: "Appel",
  tache: "Tâche",
  echeance_procedure: "Échéance de procédure",
  autre: "Autre",
};

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

// Semaine SUIVANTE par defaut (jamais la semaine en cours) - point de depart
// demande explicitement : le role de la semaine sert a preparer ce qui vient,
// jamais ce qui est deja en cours. `debut` (n'importe quelle date de la
// semaine visee) permet de naviguer vers une autre semaine (navigation
// avant/arriere cote frontend) - contrairement a l'ancien comportement
// ("semaine sur-prochaine", disponible seulement du jeudi au dimanche),
// aucune restriction d'acces par jour de semaine : la navigation manuelle
// par semaine rend ce garde-fou obsolete, l'avocat choisit lui-meme la
// semaine qu'il consulte.
function semaineDepuisRequete(req: { query: { debut?: unknown } }): { debut: Date; fin: Date } {
  const debutParam = typeof req.query.debut === "string" ? new Date(req.query.debut) : null;
  let reference: Date;
  if (debutParam && !Number.isNaN(debutParam.getTime())) {
    reference = debutParam;
  } else {
    reference = new Date();
    reference.setUTCDate(reference.getUTCDate() + 7);
  }
  const debut = lundiDeLaSemaine(reference);
  const fin = new Date(debut);
  fin.setUTCDate(fin.getUTCDate() + 7);
  return { debut, fin };
}

// Meme condition d'acces que GET /api/evenements (routes/evenements.ts,
// Lot 12a) - dupliquee ici volontairement (chaque module de routes reste
// autonome, meme convention que chargerDossierAccessible/chargerDocumentAccessible
// ailleurs dans le projet) : un evenement est visible si son dossier
// appartient a un avocat accessible, s'il n'a pas de dossier et a ete cree
// par un avocat accessible (ou soi-meme), ou si l'utilisateur y est assigne.
function accessConditionEvenements(auth: NonNullable<Express.Request["auth"]>, accessibleAvocatIds: string[] | null) {
  if (!accessibleAvocatIds) return {};
  return {
    OR: [
      { dossier: { createdBy: { in: accessibleAvocatIds } } },
      { dossierId: null, createdById: { in: [...accessibleAvocatIds, auth.userId] } },
      { assignes: { some: { userId: auth.userId } } },
    ],
  };
}

// "Role de la semaine" - donnees riches (RoleAudience) pour la semaine
// consultee (semaine suivante par defaut, navigable via `debut`). Les autres
// evenements (rdv/appel/tache/echeance_procedure/autre) sont recuperes
// separement par le frontend via GET /api/evenements (deja prevu pour ce
// filtrage, Lot 12a) - jamais duplique ici.
roleAudiencesRouter.get("/api/role-audiences/semaine", requireAuth, async (req, res) => {
  const { auth } = req;
  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";
  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth!) : null;

  const { debut, fin } = semaineDepuisRequete(req);

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

// Types a inclure dans l'export (checkboxes cote frontend, "Tout" pre-coche
// par defaut - voir role-semaine-hebdomadaire.html) - filtre invalide ou
// absent => tous les types (comportement par defaut le plus sur).
function typesSelectionnesDepuisRequete(req: { query: { types?: unknown } }): string[] {
  if (typeof req.query.types !== "string" || req.query.types.trim() === "") {
    return [...TYPES_EVENEMENT];
  }
  const demandes = req.query.types.split(",").map((t) => t.trim());
  return TYPES_EVENEMENT.filter((t) => demandes.includes(t));
}

async function exportSemaine(req: Request, res: Response, format: "pdf" | "word") {
  const { auth } = req;
  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";
  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth!) : null;

  const { debut, fin } = semaineDepuisRequete(req);
  const typesSelectionnes = typesSelectionnesDepuisRequete(req);
  const inclureAudiences = typesSelectionnes.includes("audience");
  const autresTypesSelectionnes = typesSelectionnes.filter((t) => t !== "audience");

  const audiences = inclureAudiences
    ? await prisma.roleAudience.findMany({
        where: {
          cabinetId: auth!.cabinetId,
          dateAudience: { gte: debut, lt: fin },
          ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
        },
        orderBy: { dateAudience: "asc" },
      })
    : [];

  const autresEvenements =
    autresTypesSelectionnes.length > 0
      ? await prisma.evenement.findMany({
          where: {
            cabinetId: auth!.cabinetId,
            type: { in: autresTypesSelectionnes as (typeof TYPES_EVENEMENT)[number][] },
            dateDebut: { gte: debut, lt: fin },
            ...accessConditionEvenements(auth!, accessibleAvocatIds),
          },
          orderBy: { dateDebut: "asc" },
        })
      : [];

  if (audiences.length === 0 && autresEvenements.length === 0) {
    return res.status(404).json({ error: "Aucun événement à exporter pour cette semaine." });
  }

  const cabinet = await prisma.cabinet.findUnique({ where: { id: auth!.cabinetId } });
  const exportInput = {
    cabinetNom: cabinet?.nom ?? "",
    cabinetAdresse: cabinet?.adresse ?? null,
    debut,
    fin,
    audiences,
    autresEvenements: autresEvenements.map((e) => ({
      type: LIBELLES_TYPE_EVENEMENT[e.type] || e.type,
      titre: e.titre,
      dateDebut: e.dateDebut,
      dateFin: e.dateFin,
      touteLaJournee: e.touteLaJournee,
      lieu: e.lieu,
      description: e.description,
    })),
  };

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

roleAudiencesRouter.get("/api/role-audiences/semaine/pdf", requireAuth, (req, res) => exportSemaine(req, res, "pdf"));
roleAudiencesRouter.get("/api/role-audiences/semaine/word", requireAuth, (req, res) => exportSemaine(req, res, "word"));

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

// Detail d'une audience precise - utilise par le calendrier unifie pour
// pre-remplir le formulaire d'edition et afficher les champs specifiques
// (juridiction, statut...) dans le detail d'un evenement de type "audience".
roleAudiencesRouter.get("/api/role-audiences/:id", requireAuth, async (req, res) => {
  const audience = await prisma.roleAudience.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
    include: {
      dossier: { select: { id: true, numeroDossier: true, nomAffaire: true } },
      creePar: { select: { nom: true } },
    },
  });
  if (!audience) {
    return res.status(404).json({ error: "Audience introuvable" });
  }
  return res.json(audience);
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

  // Lot 12a : hook additif - genere/tient a jour l'Evenement correspondant
  // pour le calendrier unifie. N'echoue jamais (voir evenementSync.ts) :
  // la creation du RoleAudience ci-dessus a deja reussi et sera renvoyee
  // meme si cette synchronisation echoue.
  await syncEvenementDepuisRoleAudience(audience.id);

  return res.status(201).json(audience);
});

const updateSchema = z.object({
  statut: z.enum(["a_preparer", "pret", "traite"]).optional(),
  dateAudience: z.string().min(1).optional(),
  juridiction: z.string().min(1).optional(),
  chambre: z.string().optional(),
  procedureNumero: z.string().optional(),
  parties: z.string().min(1).optional(),
  qualiteProcedurale: z.string().optional(),
  objetProcedure: z.string().optional(),
  dernierMotif: z.string().optional(),
  diligences: z.string().optional(),
  dossierId: z.string().uuid().nullable().optional(),
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

  let dateAudience: Date | undefined;
  if (parsed.data.dateAudience !== undefined) {
    dateAudience = new Date(parsed.data.dateAudience);
    if (Number.isNaN(dateAudience.getTime())) {
      return res.status(400).json({ error: "Date d'audience invalide" });
    }
  }

  let dossierId: string | null | undefined;
  if (parsed.data.dossierId !== undefined) {
    if (parsed.data.dossierId === null) {
      dossierId = null;
    } else {
      const dossier = await prisma.dossier.findFirst({
        where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId },
      });
      if (!dossier) {
        return res.status(404).json({ error: "Dossier introuvable" });
      }
      dossierId = dossier.id;
    }
  }

  const { dateAudience: _dateAudience, dossierId: _dossierId, ...rest } = parsed.data;
  const updated = await prisma.roleAudience.update({
    where: { id: existing.id },
    data: {
      ...rest,
      ...(dateAudience !== undefined ? { dateAudience } : {}),
      ...(dossierId !== undefined ? { dossierId } : {}),
    },
  });

  // Lot 12a : re-synchronise l'Evenement lie (juridiction/parties/statut
  // peuvent avoir change) - meme garde de resilience que ci-dessus.
  await syncEvenementDepuisRoleAudience(updated.id);

  return res.json(updated);
});

roleAudiencesRouter.delete("/api/role-audiences/:id", requireAuth, async (req, res) => {
  await prisma.roleAudience
    .deleteMany({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } })
    .catch(() => null);

  // Lot 12a : supprime l'Evenement lie (coherence du calendrier) - n'echoue
  // jamais, la suppression du RoleAudience ci-dessus reste effective meme
  // si cette synchronisation echoue.
  await supprimerEvenementDepuisRoleAudience(req.params.id);

  return res.json({ ok: true });
});
