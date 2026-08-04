import { Router } from "express";
import { z } from "zod";
import { Prisma, TypeAction } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { getAccessibleAvocatIds } from "../services/access";

export const dossiersRouter = Router();

// Titulaire (admin), avocat et collaborateur peuvent tous demander la vue
// "cabinet" (liste + detail de tous les dossiers) - un collaborateur reste
// par defaut sur son perimetre (getAccessibleAvocatIds), mais peut basculer
// explicitement sur "Vue cabinet" pour parcourir tous les dossiers, sans
// pour autant pouvoir les cloturer/valider/envoyer (verifie separement).
function peutVoirTouLeCabinet(role: string | undefined): boolean {
  return role === "titulaire" || role === "avocat" || role === "collaborateur";
}

// Calcule l'etiquette de statut d'un dossier : "cloture" si marque comme
// tel, "echeance_proche" si un delai calcule pour ce dossier arrive dans
// les 7 jours, sinon "a_jour".
async function computeStatutTags(dossierIds: string[]): Promise<Map<string, string>> {
  const tags = new Map<string, string>();
  if (dossierIds.length === 0) return tags;

  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const prochesEcheances = await prisma.delaiCalcul.findMany({
    where: { dossierId: { in: dossierIds }, dateLimite: { gte: now, lte: in7Days } },
    select: { dossierId: true },
  });
  const idsAvecEcheance = new Set(prochesEcheances.map((d) => d.dossierId).filter(Boolean));

  for (const id of dossierIds) {
    tags.set(id, idsAvecEcheance.has(id) ? "echeance_proche" : "a_jour");
  }
  return tags;
}

dossiersRouter.get("/api/dossiers", requireAuth, async (req, res) => {
  const { auth } = req;

  // Vue "activite d'un membre" : un avocat/titulaire consulte ce qu'un
  // collaborateur precis a cree, pour verifier ou reprendre son travail.
  // Autorise seulement pour le titulaire (n'importe qui) ou le responsable
  // direct de ce collaborateur - jamais pour un tiers.
  const membreParam = typeof req.query.membre === "string" ? req.query.membre : undefined;
  if (membreParam) {
    if (!peutVoirTouLeCabinet(auth!.role)) {
      return res.status(403).json({ error: "Réservé aux avocats du cabinet" });
    }
    const membre = await prisma.user.findFirst({
      where: { id: membreParam, cabinetId: auth!.cabinetId },
    });
    if (!membre) {
      return res.status(404).json({ error: "Membre introuvable dans ce cabinet" });
    }
    if (auth!.role !== "titulaire" && membre.responsableId !== auth!.userId) {
      return res.status(403).json({ error: "Tu ne supervises pas directement ce membre" });
    }

    // Un dossier compte pour ce membre s'il l'a lui-meme cree, OU s'il y a
    // genere au moins un document (cas le plus frequent : le dossier
    // appartient a l'avocat titulaire, le collaborateur y ajoute des actions).
    const dossiers = await prisma.dossier.findMany({
      where: {
        cabinetId: auth!.cabinetId,
        estRecherche: false,
        OR: [{ createdBy: membreParam }, { actions: { some: { createdBy: membreParam } } }],
      },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { actions: { where: { createdBy: membreParam } } } },
        creePar: { select: { nom: true } },
      },
    });
    const tags = await computeStatutTags(dossiers.map((d) => d.id));
    const dossiersAvecTag = dossiers.map((d) => ({
      ...d,
      statutTag: d.statut === "cloture" ? "cloture" : tags.get(d.id) || "a_jour",
    }));
    return res.json({ scope: "membre", vue: "dossiers", membre: { id: membre.id, nom: membre.nom }, dossiers: dossiersAvecTag });
  }

  // Un collaborateur ne peut jamais demander la vue "cabinet" complète ;
  // seuls le titulaire (admin) et un avocat le peuvent.
  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";

  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth!) : null;

  // "dossiers" (par defaut) = vrais dossiers clients actifs (non archives) ;
  // "archives" = dossiers clients archives automatiquement apres cloture ;
  // "recherches" = fiches de jurisprudence / recherche juridique / veille ;
  // "traductions" = fiches de traduction, isolees des autres recherches.
  const vueParam = req.query.vue;
  const vue =
    vueParam === "recherches"
      ? "recherches"
      : vueParam === "traductions"
        ? "traductions"
        : vueParam === "archives"
          ? "archives"
          : "dossiers";

  const dossiers = await prisma.dossier.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      estRecherche: vue === "recherches" || vue === "traductions",
      ...(vue === "dossiers" ? { archivedAt: null } : {}),
      ...(vue === "archives" ? { archivedAt: { not: null } } : {}),
      ...(vue === "traductions" ? { numeroDossier: { startsWith: "TRAD-" } } : {}),
      ...(vue === "recherches" ? { numeroDossier: { not: { startsWith: "TRAD-" } } } : {}),
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { actions: true } }, creePar: { select: { nom: true } } },
  });

  const tags = await computeStatutTags(dossiers.map((d) => d.id));
  const dossiersAvecTag = dossiers.map((d) => ({
    ...d,
    statutTag: d.statut === "cloture" ? "cloture" : tags.get(d.id) || "a_jour",
  }));

  return res.json({ scope, vue, dossiers: dossiersAvecTag });
});

// Sert la "Vue par type de document" de la page Documents generes : les
// memes filtres scope/vue que /api/dossiers ci-dessus, mais renvoie les
// documents (Action) individuellement plutot que les dossiers, tries du
// plus recent au plus ancien - le frontend les regroupe ensuite par type.
dossiersRouter.get("/api/documents", requireAuth, requireModule("documents_generes"), async (req, res) => {
  const { auth } = req;

  const requestedScope = req.query.scope === "cabinet" ? "cabinet" : "mine";
  const scope = requestedScope === "cabinet" && peutVoirTouLeCabinet(auth!.role) ? "cabinet" : "mine";
  const accessibleAvocatIds = scope === "mine" ? await getAccessibleAvocatIds(auth!) : null;

  const vueParam = req.query.vue;
  const vue =
    vueParam === "recherches"
      ? "recherches"
      : vueParam === "traductions"
        ? "traductions"
        : vueParam === "archives"
          ? "archives"
          : "dossiers";

  const documents = await prisma.action.findMany({
    where: {
      dossier: {
        cabinetId: auth!.cabinetId,
        estRecherche: vue === "recherches" || vue === "traductions",
        ...(vue === "dossiers" ? { archivedAt: null } : {}),
        ...(vue === "archives" ? { archivedAt: { not: null } } : {}),
        ...(vue === "traductions" ? { numeroDossier: { startsWith: "TRAD-" } } : {}),
        ...(vue === "recherches" ? { numeroDossier: { not: { startsWith: "TRAD-" } } } : {}),
        ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
      },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      typeAction: true,
      nomDocument: true,
      statut: true,
      documentUrl: true,
      createdAt: true,
      // destinataireEmail/envoyeAt : necessaires pour que "Documents
      // generes" (dashboard.html) puisse afficher les memes controles
      // d'envoi (et le rappel "Envoye a ... le ...") que la fiche dossier -
      // voir public/js/envoiActions.js.
      destinataireEmail: true,
      envoyeAt: true,
      dossier: { select: { id: true, numeroDossier: true, nomAffaire: true, nomClient: true, statut: true } },
      creePar: { select: { nom: true } },
    },
  });

  // Etiquette "echeance proche" (delai calcule sous 7 jours pour le
  // dossier) - meme calcul que sur la liste des dossiers, pour que
  // "Documents generes" alerte aussi sans avoir a rouvrir chaque dossier.
  const dossierIds = [...new Set(documents.map((d) => d.dossier.id))];
  const tags = await computeStatutTags(dossierIds);
  const documentsAvecTag = documents.map((d) => ({
    ...d,
    dossier: { ...d.dossier, statutTag: d.dossier.statut === "cloture" ? "cloture" : tags.get(d.dossier.id) || "a_jour" },
  }));

  return res.json({ scope, vue, documents: documentsAvecTag });
});

dossiersRouter.get("/api/dossiers/:id", requireAuth, async (req, res) => {
  const { auth } = req;

  // Le titulaire (admin) et un avocat voient tout le cabinet ; un
  // collaborateur seulement les dossiers des avocats auxquels il a accès.
  const accessibleAvocatIds = peutVoirTouLeCabinet(auth!.role)
    ? null
    : await getAccessibleAvocatIds(auth!);

  const dossier = await prisma.dossier.findFirst({
    where: {
      id: req.params.id,
      cabinetId: auth!.cabinetId,
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
    include: {
      creePar: { select: { nom: true } },
      actions: {
        orderBy: { createdAt: "desc" },
        include: { creePar: { select: { nom: true } } },
      },
    },
  });

  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  const tags = await computeStatutTags([dossier.id]);
  const statutTag = dossier.statut === "cloture" ? "cloture" : tags.get(dossier.id) || "a_jour";

  return res.json({ ...dossier, statutTag });
});

// Sert au bouton generique "Pre-remplir depuis un autre acte" present sur
// tous les formulaires : recupere les champs saisis lors du dernier acte
// d'un type donne pour ce dossier, s'il y en a. Le frontend se charge de
// mapper les champs recus sur les noms de champs du formulaire cible.
dossiersRouter.get("/api/dossiers/:id/dernier-document", requireAuth, async (req, res) => {
  const { auth } = req;

  const typeParam = typeof req.query.type === "string" ? req.query.type : "";
  if (!typeParam || !(typeParam in TypeAction)) {
    return res.status(400).json({ error: "Paramètre type invalide" });
  }
  const type = typeParam as TypeAction;

  const dossier = await prisma.dossier.findFirst({
    where: { id: req.params.id, cabinetId: auth!.cabinetId },
  });
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  const action = await prisma.action.findFirst({
    where: { dossierId: dossier.id, typeAction: type, champsFormulaire: { not: Prisma.JsonNull } },
    orderBy: { createdAt: "desc" },
  });
  if (!action || !action.champsFormulaire) {
    return res.status(404).json({ error: "Aucun document de ce type trouvé pour ce dossier" });
  }

  return res.json({ champs: action.champsFormulaire });
});

const updateStatutSchema = z.object({
  statut: z.enum(["actif", "cloture"]),
});

dossiersRouter.patch("/api/dossiers/:id", requireAuth, async (req, res) => {
  const { auth } = req;
  const parsed = updateStatutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Statut invalide" });
  }

  // Seul un avocat (ou le titulaire) peut cloturer/rouvrir un dossier -
  // jamais un collaborateur, meme sur un dossier qu'il a lui-meme cree.
  if (auth!.role === "collaborateur") {
    return res.status(403).json({ error: "Seul un avocat du cabinet peut clôturer un dossier." });
  }

  const accessibleAvocatIds = peutVoirTouLeCabinet(auth!.role)
    ? null
    : await getAccessibleAvocatIds(auth!);

  const dossier = await prisma.dossier.findFirst({
    where: {
      id: req.params.id,
      cabinetId: auth!.cabinetId,
      ...(accessibleAvocatIds ? { createdBy: { in: accessibleAvocatIds } } : {}),
    },
  });
  if (!dossier) {
    return res.status(404).json({ error: "Dossier introuvable" });
  }

  await prisma.dossier.update({
    where: { id: dossier.id },
    data:
      parsed.data.statut === "cloture"
        ? { statut: "cloture", dateCloture: new Date() }
        : { statut: "actif", dateCloture: null, archivedAt: null },
  });
  return res.json({ ok: true });
});
