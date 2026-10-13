import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { logAuditPersonnel } from "../services/audit";
import { calculerFichePaie, recalculerEtEnregistrer, NetNegatifError } from "../services/paie";
import { buildFichePaiePdf } from "../services/fichePaiePdf";
import { enregistrerFichier, lireFichier } from "../services/stockageDocuments";

export const paieRouter = Router();

paieRouter.use(
  ["/api/personnel", "/api/periodes-paie", "/api/ajustements-mensuels", "/api/fiches-paie", "/api/elements-salaire"],
  requireAuth,
  requireModule("rh_paie")
);

function messageErreur(error: unknown): string {
  if (error instanceof NetNegatifError) {
    return "Cette modification ferait passer le net à payer sous zéro - refusée.";
  }
  throw error;
}

// --- Elements de salaire ---

const CATEGORIES_SENS = ["gain", "retenue"] as const;
const MODES_CALCUL = ["montant_fixe", "pourcentage"] as const;
const BASES_CALCUL = ["salaire_base", "brut"] as const;

async function trouverFicheAccessiblePaie(id: string, req: { auth?: { cabinetId: string; role: string; userId: string } }) {
  const fiche = await prisma.fichePersonnel.findFirst({ where: { id, cabinetId: req.auth!.cabinetId } });
  if (!fiche) return null;
  if (req.auth!.role !== "titulaire" && fiche.userId !== req.auth!.userId) return undefined;
  return fiche;
}

paieRouter.get("/api/personnel/:id/elements-salaire", async (req, res) => {
  const fiche = await trouverFicheAccessiblePaie(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Accès refusé à cette fiche." });

  const elements = await prisma.elementSalaire.findMany({ where: { fichePersonnelId: fiche.id }, orderBy: { dateDebut: "asc" } });
  return res.json(elements);
});

const elementSalaireSchema = z.object({
  sens: z.enum(CATEGORIES_SENS),
  libelle: z.string().trim().min(1),
  modeCalcul: z.enum(MODES_CALCUL),
  valeur: z.number().int(),
  baseCalcul: z.enum(BASES_CALCUL).optional(),
  estSalaireBase: z.boolean().default(false),
});

// Creation/gestion reservee au titulaire - meme decision que le reste du
// module RH (docs/rh/00-audit.md, 13/10/2026).
paieRouter.post("/api/personnel/:id/elements-salaire", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut gérer les éléments de salaire." });
  const parsed = elementSalaireSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const fiche = await prisma.fichePersonnel.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId } });
  if (!fiche) return res.status(404).json({ error: "Fiche introuvable" });

  if (parsed.data.modeCalcul === "pourcentage" && !parsed.data.baseCalcul) {
    return res.status(400).json({ error: "La base de calcul est requise pour un pourcentage." });
  }

  const element = await prisma.elementSalaire.create({
    data: {
      fichePersonnelId: fiche.id,
      sens: parsed.data.sens,
      libelle: parsed.data.libelle,
      modeCalcul: parsed.data.modeCalcul,
      valeur: parsed.data.valeur,
      baseCalcul: parsed.data.modeCalcul === "pourcentage" ? parsed.data.baseCalcul : null,
      estSalaireBase: parsed.data.estSalaireBase,
    },
  });

  await logAuditPersonnel(fiche.id, "element_salaire_cree", "succes", `Créé par ${req.auth!.userId} (sans montant ni libellé dans ce journal)`);
  return res.status(201).json(element);
});

const modifierElementSchema = z.object({ actif: z.boolean().optional(), dateFin: z.string().optional().nullable() });

paieRouter.patch("/api/elements-salaire/:id", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut gérer les éléments de salaire." });
  const parsed = modifierElementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const element = await prisma.elementSalaire.findFirst({
    where: { id: req.params.id, fichePersonnel: { cabinetId: req.auth!.cabinetId } },
  });
  if (!element) return res.status(404).json({ error: "Élément introuvable" });

  const misAJour = await prisma.elementSalaire.update({
    where: { id: element.id },
    data: {
      ...(parsed.data.actif !== undefined ? { actif: parsed.data.actif } : {}),
      ...(parsed.data.dateFin !== undefined ? { dateFin: parsed.data.dateFin ? new Date(parsed.data.dateFin) : null } : {}),
    },
  });
  return res.json(misAJour);
});

// --- Periodes de paie ---

const SELECT_FICHE_PAIE = {
  id: true,
  periodePaieId: true,
  fichePersonnelId: true,
  numero: true,
  statut: true,
  version: true,
  brut: true,
  totalRetenues: true,
  net: true,
  valideLe: true,
  fichePersonnel: { select: { id: true, nom: true, prenoms: true, fonction: true } },
  lignes: { orderBy: { ordre: "asc" as const } },
} as const;

const ouvrirPeriodeSchema = z.object({ mois: z.string().regex(/^\d{4}-\d{2}$/, "Format attendu : AAAA-MM") });

// Ouverture de periode : genere un brouillon de FichePaie par employe actif,
// a partir de ses ElementSalaire en vigueur - regenerable (DELETE + recreate
// les brouillons) tant qu'aucune fiche de cette periode n'est validee.
paieRouter.post("/api/periodes-paie", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut ouvrir une période de paie." });
  const parsed = ouvrirPeriodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  let periode = await prisma.periodePaie.findUnique({ where: { cabinetId_mois: { cabinetId: req.auth!.cabinetId, mois: parsed.data.mois } } });
  if (periode) {
    const uneValidee = await prisma.fichePaie.findFirst({ where: { periodePaieId: periode.id, statut: "validee" } });
    if (uneValidee) return res.status(409).json({ error: "Cette période contient déjà au moins une fiche validée - régénération impossible." });
    await prisma.fichePaie.deleteMany({ where: { periodePaieId: periode.id, statut: "brouillon" } });
  } else {
    periode = await prisma.periodePaie.create({ data: { cabinetId: req.auth!.cabinetId, mois: parsed.data.mois } });
  }

  const fichesActives = await prisma.fichePersonnel.findMany({ where: { cabinetId: req.auth!.cabinetId, statut: "actif" } });
  for (const fiche of fichesActives) {
    const fichePaie = await prisma.fichePaie.create({
      data: { cabinetId: req.auth!.cabinetId, periodePaieId: periode.id, fichePersonnelId: fiche.id },
    });
    try {
      await recalculerEtEnregistrer(fichePaie.id, fiche.id, parsed.data.mois);
    } catch (error) {
      if (!(error instanceof NetNegatifError)) throw error;
      // Net negatif des la generation (element de salaire mal configure) -
      // on laisse la fiche a 0/0/0, visible et corrigible par le titulaire
      // plutot que de bloquer l'ouverture de toute la periode pour les autres.
    }
  }

  const fiches = await prisma.fichePaie.findMany({ where: { periodePaieId: periode.id }, select: SELECT_FICHE_PAIE });
  return res.status(201).json({ ...periode, fiches });
});

paieRouter.get("/api/periodes-paie/:mois", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut consulter la paie du mois." });
  const periode = await prisma.periodePaie.findUnique({ where: { cabinetId_mois: { cabinetId: req.auth!.cabinetId, mois: req.params.mois } } });
  if (!periode) return res.status(404).json({ error: "Aucune période ouverte pour ce mois." });
  const fiches = await prisma.fichePaie.findMany({ where: { periodePaieId: periode.id }, select: SELECT_FICHE_PAIE });
  return res.json({ ...periode, fiches });
});

// --- Ajustements mensuels ---

const ajustementSchema = z.object({ fichePersonnelId: z.string().uuid(), sens: z.enum(CATEGORIES_SENS), libelle: z.string().trim().min(1), montant: z.number().int().positive() });

paieRouter.post("/api/periodes-paie/:mois/ajustements", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut ajouter un ajustement." });
  const parsed = ajustementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const periode = await prisma.periodePaie.findUnique({ where: { cabinetId_mois: { cabinetId: req.auth!.cabinetId, mois: req.params.mois } } });
  if (!periode) return res.status(404).json({ error: "Aucune période ouverte pour ce mois." });

  const fichePaie = await prisma.fichePaie.findFirst({ where: { periodePaieId: periode.id, fichePersonnelId: parsed.data.fichePersonnelId } });
  if (!fichePaie) return res.status(404).json({ error: "Aucune fiche de paie pour cet employé sur cette période." });
  if (fichePaie.statut !== "brouillon") return res.status(409).json({ error: "Cette fiche est déjà validée - impossible d'ajouter un ajustement." });

  const ajustement = await prisma.ajustementMensuel.create({ data: { ...parsed.data, periodePaieId: periode.id } });

  try {
    await recalculerEtEnregistrer(fichePaie.id, parsed.data.fichePersonnelId, req.params.mois);
  } catch (error) {
    await prisma.ajustementMensuel.delete({ where: { id: ajustement.id } });
    return res.status(400).json({ error: messageErreur(error) });
  }

  const misAJour = await prisma.fichePaie.findUniqueOrThrow({ where: { id: fichePaie.id }, select: SELECT_FICHE_PAIE });
  return res.status(201).json(misAJour);
});

paieRouter.delete("/api/ajustements-mensuels/:id", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut supprimer un ajustement." });

  const ajustement = await prisma.ajustementMensuel.findFirst({
    where: { id: req.params.id, periodePaie: { cabinetId: req.auth!.cabinetId } },
    include: { periodePaie: true },
  });
  if (!ajustement) return res.status(404).json({ error: "Ajustement introuvable" });

  const fichePaie = await prisma.fichePaie.findFirst({ where: { periodePaieId: ajustement.periodePaieId, fichePersonnelId: ajustement.fichePersonnelId } });
  if (fichePaie && fichePaie.statut !== "brouillon") {
    return res.status(409).json({ error: "Cette fiche est déjà validée - impossible de modifier ses ajustements." });
  }

  await prisma.ajustementMensuel.delete({ where: { id: ajustement.id } });
  if (fichePaie) await recalculerEtEnregistrer(fichePaie.id, ajustement.fichePersonnelId, ajustement.periodePaie.mois);

  return res.json({ ok: true });
});

// --- Fiches de paie : consultation, validation, annulation ---

async function trouverFichePaieAccessible(id: string, req: { auth?: { cabinetId: string; role: string; userId: string } }) {
  const fichePaie = await prisma.fichePaie.findFirst({
    where: { id, cabinetId: req.auth!.cabinetId },
    include: { fichePersonnel: { select: { userId: true } }, periodePaie: true },
  });
  if (!fichePaie) return null;
  if (req.auth!.role === "titulaire") return fichePaie;
  // Un employe n'accede qu'a SES PROPRES fiches VALIDEES (spec section 3 et 8).
  if (fichePaie.fichePersonnel.userId === req.auth!.userId && fichePaie.statut === "validee") return fichePaie;
  return undefined;
}

paieRouter.get("/api/fiches-paie/:id", async (req, res) => {
  const fichePaie = await trouverFichePaieAccessible(req.params.id, req);
  if (fichePaie === null) return res.status(404).json({ error: "Fiche de paie introuvable" });
  if (fichePaie === undefined) return res.status(403).json({ error: "Tu ne peux consulter que tes propres fiches validées." });

  const complet = await prisma.fichePaie.findUniqueOrThrow({ where: { id: fichePaie.id }, select: SELECT_FICHE_PAIE });
  await logAuditPersonnel(fichePaie.fichePersonnelId, "fiche_paie_consultee", "succes", `Consultée par ${req.auth!.userId}`);
  return res.json(complet);
});

paieRouter.get("/api/personnel/:id/fiches-paie", async (req, res) => {
  const fiche = await trouverFicheAccessiblePaie(req.params.id, req);
  if (fiche === null) return res.status(404).json({ error: "Fiche introuvable" });
  if (fiche === undefined) return res.status(403).json({ error: "Accès refusé à cette fiche." });

  const fichesPaie = await prisma.fichePaie.findMany({
    where: { fichePersonnelId: fiche.id, ...(req.auth!.role === "titulaire" ? {} : { statut: "validee" }) },
    select: { ...SELECT_FICHE_PAIE, periodePaie: { select: { mois: true } } },
    orderBy: { createdAt: "desc" },
  });
  return res.json(fichesPaie);
});

paieRouter.post("/api/fiches-paie/:id/valider", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut valider une fiche de paie." });

  const fichePaie = await prisma.fichePaie.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
    include: { fichePersonnel: true, periodePaie: true },
  });
  if (!fichePaie) return res.status(404).json({ error: "Fiche de paie introuvable" });
  if (fichePaie.statut !== "brouillon") return res.status(409).json({ error: "Cette fiche a déjà été validée ou annulée." });

  let resultat;
  try {
    resultat = await recalculerEtEnregistrer(fichePaie.id, fichePaie.fichePersonnelId, fichePaie.periodePaie.mois);
  } catch (error) {
    return res.status(400).json({ error: messageErreur(error) });
  }

  const [annee, mois] = fichePaie.periodePaie.mois.split("-");
  const compte = await prisma.fichePaie.count({ where: { cabinetId: req.auth!.cabinetId, periodePaieId: fichePaie.periodePaieId, statut: "validee" } });
  const numero = `PAIE-${annee}-${mois}-${String(compte + 1).padStart(3, "0")}`;

  const cabinet = await prisma.cabinet.findUniqueOrThrow({ where: { id: req.auth!.cabinetId }, select: { nom: true } });
  const pdfBuffer = await buildFichePaiePdf({
    cabinetNom: cabinet.nom,
    numero,
    mois: fichePaie.periodePaie.mois,
    nomEmploye: `${fichePaie.fichePersonnel.nom}${fichePaie.fichePersonnel.prenoms ? " " + fichePaie.fichePersonnel.prenoms : ""}`,
    fonction: fichePaie.fichePersonnel.fonction,
    lignes: resultat.lignes,
    brut: resultat.brut,
    totalRetenues: resultat.totalRetenues,
    net: resultat.net,
  });
  const { nomFichier } = await enregistrerFichier(`paie-${fichePaie.id}`, pdfBuffer);

  const misAJour = await prisma.fichePaie.update({
    where: { id: fichePaie.id },
    data: { statut: "validee", numero, valideLe: new Date(), valideParId: req.auth!.userId, cheminPdf: nomFichier },
    select: SELECT_FICHE_PAIE,
  });

  await logAuditPersonnel(fichePaie.fichePersonnelId, "fiche_paie_validee", "succes", `Validée par ${req.auth!.userId} (${numero})`);
  return res.json(misAJour);
});

const annulerSchema = z.object({ motif: z.string().trim().min(1, "Le motif est requis.") });

// Annulation : la fiche validee devient "annulee" (ARCHIVEE, jamais
// supprimee ni modifiee - spec section 4) et une NOUVELLE version
// brouillon est creee pour correction (spec section 5.4, cycle de vie
// etape 4).
paieRouter.post("/api/fiches-paie/:id/annuler", async (req, res) => {
  if (req.auth!.role !== "titulaire") return res.status(403).json({ error: "Seul le titulaire peut annuler une fiche de paie." });
  const parsed = annulerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });

  const fichePaie = await prisma.fichePaie.findFirst({ where: { id: req.params.id, cabinetId: req.auth!.cabinetId }, include: { periodePaie: true } });
  if (!fichePaie) return res.status(404).json({ error: "Fiche de paie introuvable" });
  if (fichePaie.statut !== "validee") return res.status(409).json({ error: "Seule une fiche validée peut être annulée." });

  const nouvelleVersion = await prisma.$transaction(async (tx) => {
    await tx.fichePaie.update({ where: { id: fichePaie.id }, data: { statut: "annulee" } });
    return tx.fichePaie.create({
      data: {
        cabinetId: req.auth!.cabinetId,
        periodePaieId: fichePaie.periodePaieId,
        fichePersonnelId: fichePaie.fichePersonnelId,
        version: fichePaie.version + 1,
      },
    });
  });

  await recalculerEtEnregistrer(nouvelleVersion.id, fichePaie.fichePersonnelId, fichePaie.periodePaie.mois).catch(() => undefined);

  await logAuditPersonnel(
    fichePaie.fichePersonnelId,
    "fiche_paie_annulee",
    "succes",
    `Annulée par ${req.auth!.userId} - motif (non détaillé ici, voir dossier RH) - nouvelle version créée`
  );

  const complet = await prisma.fichePaie.findUniqueOrThrow({ where: { id: nouvelleVersion.id }, select: SELECT_FICHE_PAIE });
  return res.status(201).json(complet);
});

paieRouter.get("/api/fiches-paie/:id/pdf", async (req, res) => {
  const fichePaie = await trouverFichePaieAccessible(req.params.id, req);
  if (fichePaie === null) return res.status(404).json({ error: "Fiche de paie introuvable" });
  if (fichePaie === undefined) return res.status(403).json({ error: "Tu ne peux consulter que tes propres fiches validées." });
  if (!fichePaie.cheminPdf) return res.status(404).json({ error: "Aucun PDF disponible pour cette fiche." });

  const buffer = await lireFichier(`paie-${fichePaie.id}`, fichePaie.cheminPdf);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fichePaie.numero || "fiche-paie"}.pdf"`);
  return res.send(buffer);
});
