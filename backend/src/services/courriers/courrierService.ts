import type { NatureCourrier, ModeCourrier, StatutCourrierEntrant, StatutCourrierSortant } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logAuditCourrier } from "../audit";
import { genererNumeroCourrier } from "./numerotation";
import { enregistrerFichier, lireFichier, supprimerFichier } from "../stockageDocuments";
import { enqueuerTraitementOcr } from "../../jobs/traitementOcr";
import { computeDeadline } from "../delais";
import { syncEvenementDepuisDelaiCalcul } from "../evenementSync";

/**
 * Lot 20 - coeur metier du registre courrier. Reutilise integralement les
 * briques existantes (stockageDocuments.ts, jobs/traitementOcr.ts,
 * services/delais.ts + evenementSync.ts, services/audit.ts) - jamais de
 * logique dupliquee. Voir README-LOT20.md pour le detail des choix.
 */

const INCLUDE_ENTRANT_DETAIL = {
  receptionnePar: { select: { id: true, nom: true } },
  affecteA: { select: { id: true, nom: true } },
  client: { select: { id: true, nom: true } },
  dossier: { select: { id: true, nomAffaire: true, numeroDossier: true } },
  documents: { select: { id: true, nomOriginal: true, typeMime: true, tailleOctets: true, createdAt: true } },
  piecesJointes: { select: { id: true, nomOriginal: true, typeMime: true, tailleOctets: true, createdAt: true } },
  delaiCalculs: { include: { delaiType: true } },
  actions: { select: { id: true, typeAction: true, nomDocument: true, statut: true, createdAt: true } },
  reponses: { select: { id: true, numero: true, objet: true, statut: true, dateEnvoi: true, createdAt: true } },
  auditLogs: { orderBy: { timestamp: "asc" } },
} as const;

const INCLUDE_SORTANT_DETAIL = {
  redigePar: { select: { id: true, nom: true } },
  client: { select: { id: true, nom: true } },
  dossier: { select: { id: true, nomAffaire: true, numeroDossier: true } },
  documents: { select: { id: true, nomOriginal: true, typeMime: true, tailleOctets: true, createdAt: true } },
  piecesJointes: { select: { id: true, nomOriginal: true, typeMime: true, tailleOctets: true, createdAt: true } },
  reponseA: { select: { id: true, numero: true, objet: true, expediteur: true } },
  auditLogs: { orderBy: { timestamp: "asc" } },
} as const;

async function chargerDossierAccessible(dossierId: string, cabinetId: string) {
  return prisma.dossier.findFirst({ where: { id: dossierId, cabinetId } });
}

async function chargerClientAccessible(clientId: string, cabinetId: string) {
  return prisma.client.findFirst({ where: { id: clientId, cabinetId } });
}

// ---------------------------------------------------------------------------
// Creation - "saisie rapide" : seul `objet` est obligatoire, tout le reste
// est optionnel/completable plus tard (voir mettreAJourCourrierEntrant).
// ---------------------------------------------------------------------------

export interface CreerCourrierEntrantInput {
  objet: string;
  nature?: NatureCourrier;
  expediteur?: string;
  dateCourrier?: Date;
  dateReception?: Date;
  modeReception?: ModeCourrier;
  clientId?: string;
  dossierId?: string;
  observations?: string;
}

export async function creerCourrierEntrant(
  cabinetId: string,
  userId: string,
  input: CreerCourrierEntrantInput
) {
  if (input.clientId && !(await chargerClientAccessible(input.clientId, cabinetId))) {
    throw new Error("CLIENT_INTROUVABLE");
  }
  if (input.dossierId && !(await chargerDossierAccessible(input.dossierId, cabinetId))) {
    throw new Error("DOSSIER_INTROUVABLE");
  }

  const numero = await genererNumeroCourrier(cabinetId, "entrant");

  const courrier = await prisma.courrierEntrant.create({
    data: {
      cabinetId,
      numero,
      objet: input.objet,
      nature: input.nature,
      expediteur: input.expediteur,
      dateCourrier: input.dateCourrier,
      dateReception: input.dateReception ?? new Date(),
      modeReception: input.modeReception,
      receptionneParId: userId,
      clientId: input.clientId,
      dossierId: input.dossierId,
      observations: input.observations,
      // Statut initial toujours automatique ("Reçu") - jamais un choix a la
      // creation, contrainte explicite du prompt.
      statut: "recu",
    },
  });

  await logAuditCourrier({ courrierEntrantId: courrier.id }, "creation", "succes", `Courrier reçu créé (${numero})`);
  return courrier;
}

export interface CreerCourrierSortantInput {
  objet: string;
  nature?: NatureCourrier;
  destinataire?: string;
  dateCourrier?: Date;
  modeEnvoi?: ModeCourrier;
  clientId?: string;
  dossierId?: string;
  observations?: string;
  // Renseigne uniquement depuis le bouton "Répondre au courrier" d'une
  // fiche CourrierEntrant - chainage bidirectionnel visible des deux cotes
  // (voir INCLUDE_ENTRANT_DETAIL.reponses / INCLUDE_SORTANT_DETAIL.reponseA).
  reponseAId?: string;
}

export async function creerCourrierSortant(
  cabinetId: string,
  userId: string,
  input: CreerCourrierSortantInput
) {
  if (input.clientId && !(await chargerClientAccessible(input.clientId, cabinetId))) {
    throw new Error("CLIENT_INTROUVABLE");
  }
  if (input.dossierId && !(await chargerDossierAccessible(input.dossierId, cabinetId))) {
    throw new Error("DOSSIER_INTROUVABLE");
  }
  if (input.reponseAId) {
    const origine = await prisma.courrierEntrant.findFirst({ where: { id: input.reponseAId, cabinetId } });
    if (!origine) throw new Error("COURRIER_ORIGINE_INTROUVABLE");
  }

  const numero = await genererNumeroCourrier(cabinetId, "sortant");

  const courrier = await prisma.courrierSortant.create({
    data: {
      cabinetId,
      numero,
      objet: input.objet,
      nature: input.nature,
      destinataire: input.destinataire,
      dateCourrier: input.dateCourrier,
      modeEnvoi: input.modeEnvoi,
      clientId: input.clientId,
      dossierId: input.dossierId,
      observations: input.observations,
      reponseAId: input.reponseAId,
      redigeParId: userId,
      statut: "brouillon",
    },
  });

  await logAuditCourrier(
    { courrierSortantId: courrier.id },
    "creation",
    "succes",
    input.reponseAId ? `Réponse créée (${numero})` : `Courrier sortant créé (${numero})`
  );
  return courrier;
}

// ---------------------------------------------------------------------------
// Lecture / listes / filtres / compteurs tableau de bord
// ---------------------------------------------------------------------------

export interface FiltresCourrierEntrant {
  q?: string;
  nature?: NatureCourrier;
  statut?: StatutCourrierEntrant;
  clientId?: string;
  dossierId?: string;
  affecteAId?: string;
  dateDebut?: Date;
  dateFin?: Date;
  vue?: "aujourdhui" | "a_traiter" | "a_affecter" | "avec_echeance" | "archives";
}

export async function listerCourriersEntrants(cabinetId: string, filtres: FiltresCourrierEntrant) {
  const where: Record<string, unknown> = { cabinetId };
  if (filtres.nature) where.nature = filtres.nature;
  if (filtres.statut) where.statut = filtres.statut;
  if (filtres.clientId) where.clientId = filtres.clientId;
  if (filtres.dossierId) where.dossierId = filtres.dossierId;
  if (filtres.affecteAId) where.affecteAId = filtres.affecteAId;
  if (filtres.q) {
    where.OR = [
      { objet: { contains: filtres.q, mode: "insensitive" } },
      { expediteur: { contains: filtres.q, mode: "insensitive" } },
      { numero: { contains: filtres.q, mode: "insensitive" } },
    ];
  }
  if (filtres.dateDebut || filtres.dateFin) {
    where.dateReception = {
      ...(filtres.dateDebut ? { gte: filtres.dateDebut } : {}),
      ...(filtres.dateFin ? { lte: filtres.dateFin } : {}),
    };
  }

  if (filtres.vue === "aujourdhui") {
    const debut = new Date();
    debut.setHours(0, 0, 0, 0);
    where.dateReception = { gte: debut };
  } else if (filtres.vue === "a_traiter") {
    where.statut = { in: ["affecte", "en_traitement"] };
  } else if (filtres.vue === "a_affecter") {
    where.statut = "a_affecter";
  } else if (filtres.vue === "avec_echeance") {
    where.delaiCalculs = { some: {} };
    where.statut = { not: "classe" };
  } else if (filtres.vue === "archives") {
    where.statut = "classe";
  }

  return prisma.courrierEntrant.findMany({
    where,
    include: {
      client: { select: { nom: true } },
      dossier: { select: { nomAffaire: true, numeroDossier: true } },
      affecteA: { select: { nom: true } },
    },
    orderBy: { dateReception: "desc" },
    take: 200,
  });
}

export interface FiltresCourrierSortant {
  q?: string;
  nature?: NatureCourrier;
  statut?: StatutCourrierSortant;
  clientId?: string;
  dossierId?: string;
  vue?: "ce_mois" | "archives";
}

export async function listerCourriersSortants(cabinetId: string, filtres: FiltresCourrierSortant) {
  const where: Record<string, unknown> = { cabinetId };
  if (filtres.nature) where.nature = filtres.nature;
  if (filtres.statut) where.statut = filtres.statut;
  if (filtres.clientId) where.clientId = filtres.clientId;
  if (filtres.dossierId) where.dossierId = filtres.dossierId;
  if (filtres.q) {
    where.OR = [
      { objet: { contains: filtres.q, mode: "insensitive" } },
      { destinataire: { contains: filtres.q, mode: "insensitive" } },
      { numero: { contains: filtres.q, mode: "insensitive" } },
    ];
  }

  if (filtres.vue === "ce_mois") {
    const debutMois = new Date();
    debutMois.setDate(1);
    debutMois.setHours(0, 0, 0, 0);
    where.statut = "envoye";
    where.dateEnvoi = { gte: debutMois };
  } else if (filtres.vue === "archives") {
    where.statut = "classe";
  }

  return prisma.courrierSortant.findMany({
    where,
    include: {
      client: { select: { nom: true } },
      dossier: { select: { nomAffaire: true, numeroDossier: true } },
      redigePar: { select: { nom: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function obtenirCourrierEntrant(id: string, cabinetId: string) {
  return prisma.courrierEntrant.findFirst({ where: { id, cabinetId }, include: INCLUDE_ENTRANT_DETAIL });
}

export async function obtenirCourrierSortant(id: string, cabinetId: string) {
  return prisma.courrierSortant.findFirst({ where: { id, cabinetId }, include: INCLUDE_SORTANT_DETAIL });
}

/**
 * Compteurs du tableau de bord - uniquement des COUNT agreges (jamais un
 * chargement complet des lignes en memoire), contrainte explicite du
 * prompt pour que ce widget reste rapide meme si le volume grossit.
 */
export async function compterCourriers(cabinetId: string) {
  const debutJour = new Date();
  debutJour.setHours(0, 0, 0, 0);
  const debutMois = new Date();
  debutMois.setDate(1);
  debutMois.setHours(0, 0, 0, 0);

  const [recusAujourdhui, aTraiter, aAffecter, avecEcheance, envoyesCeMois] = await Promise.all([
    prisma.courrierEntrant.count({ where: { cabinetId, dateReception: { gte: debutJour } } }),
    prisma.courrierEntrant.count({ where: { cabinetId, statut: { in: ["affecte", "en_traitement"] } } }),
    prisma.courrierEntrant.count({ where: { cabinetId, statut: "a_affecter" } }),
    prisma.courrierEntrant.count({ where: { cabinetId, statut: { not: "classe" }, delaiCalculs: { some: {} } } }),
    prisma.courrierSortant.count({ where: { cabinetId, statut: "envoye", dateEnvoi: { gte: debutMois } } }),
  ]);

  return { recusAujourdhui, aTraiter, aAffecter, avecEcheance, envoyesCeMois };
}

/**
 * "Notification" d'affectation (Lot 20, objectif 7) : aucun mecanisme de
 * notification in-app generique n'existe ailleurs dans Aurore (verifie -
 * seul un motif ponctuel similaire existe pour la veille juridique,
 * routes/veilleJuridiqueNotification.ts, propre a un seul Action par
 * digest). Implementation minimale et coherente avec ce precedent : un
 * simple compteur interroge par polling (voir routes/courriers.ts, GET
 * .../notifications), sans nouvelle table - le badge disparait de lui-meme
 * des que l'utilisateur fait avancer le statut, aucun etat "vu" a
 * maintenir separement. Documentee ici comme nouvelle brique (contrainte du
 * prompt : documenter clairement si aucun mecanisme existant n'est reutilise).
 */
export async function compterCourriersAffectesA(cabinetId: string, userId: string): Promise<number> {
  return prisma.courrierEntrant.count({
    where: { cabinetId, affecteAId: userId, statut: { in: ["affecte", "en_traitement"] } },
  });
}

// ---------------------------------------------------------------------------
// Mise a jour ("compléter la fiche") - jamais bloquant, chaque champ reste
// individuellement optionnel.
// ---------------------------------------------------------------------------

export interface MettreAJourCourrierEntrantInput {
  objet?: string;
  nature?: NatureCourrier | null;
  expediteur?: string | null;
  dateCourrier?: Date | null;
  modeReception?: ModeCourrier | null;
  clientId?: string | null;
  dossierId?: string | null;
  observations?: string | null;
}

export async function mettreAJourCourrierEntrant(
  id: string,
  cabinetId: string,
  input: MettreAJourCourrierEntrantInput
) {
  const courrier = await prisma.courrierEntrant.findFirst({ where: { id, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");

  if (input.clientId && !(await chargerClientAccessible(input.clientId, cabinetId))) {
    throw new Error("CLIENT_INTROUVABLE");
  }
  const rattacheUnDossier = input.dossierId && input.dossierId !== courrier.dossierId;
  if (input.dossierId && !(await chargerDossierAccessible(input.dossierId, cabinetId))) {
    throw new Error("DOSSIER_INTROUVABLE");
  }

  const misAJour = await prisma.courrierEntrant.update({ where: { id }, data: input });

  if (rattacheUnDossier && input.dossierId) {
    await migrerPiecesJointesVersDossier("courrierEntrantId", id, input.dossierId, cabinetId);
    await logAuditCourrier({ courrierEntrantId: id }, "dossier_rattache", "succes", `Dossier ${input.dossierId} rattaché`);
  }

  return misAJour;
}

export interface MettreAJourCourrierSortantInput {
  objet?: string;
  nature?: NatureCourrier | null;
  destinataire?: string | null;
  dateCourrier?: Date | null;
  modeEnvoi?: ModeCourrier | null;
  clientId?: string | null;
  dossierId?: string | null;
  observations?: string | null;
}

export async function mettreAJourCourrierSortant(
  id: string,
  cabinetId: string,
  input: MettreAJourCourrierSortantInput
) {
  const courrier = await prisma.courrierSortant.findFirst({ where: { id, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");

  if (input.clientId && !(await chargerClientAccessible(input.clientId, cabinetId))) {
    throw new Error("CLIENT_INTROUVABLE");
  }
  const rattacheUnDossier = input.dossierId && input.dossierId !== courrier.dossierId;
  if (input.dossierId && !(await chargerDossierAccessible(input.dossierId, cabinetId))) {
    throw new Error("DOSSIER_INTROUVABLE");
  }

  const misAJour = await prisma.courrierSortant.update({ where: { id }, data: input });

  if (rattacheUnDossier && input.dossierId) {
    await migrerPiecesJointesVersDossier("courrierSortantId", id, input.dossierId, cabinetId);
    await logAuditCourrier({ courrierSortantId: id }, "dossier_rattache", "succes", `Dossier ${input.dossierId} rattaché`);
  }

  return misAJour;
}

// ---------------------------------------------------------------------------
// Statuts / affectation / classement
// ---------------------------------------------------------------------------

export async function affecterCourrierEntrant(id: string, cabinetId: string, affecteAId: string) {
  const courrier = await prisma.courrierEntrant.findFirst({ where: { id, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");
  // Meme perimetre de roles que GET /api/courriers-entrants-affectables
  // (jamais un compte super_admin/plateforme, meme si techniquement rattache
  // a ce cabinetId - voir routes/admin.ts, CABINET_PLATEFORME_ID).
  const utilisateur = await prisma.user.findFirst({
    where: { id: affecteAId, cabinetId, actif: true, role: { in: ["titulaire", "avocat", "collaborateur"] } },
  });
  if (!utilisateur) throw new Error("UTILISATEUR_INTROUVABLE");

  const misAJour = await prisma.courrierEntrant.update({
    where: { id },
    data: {
      affecteAId,
      affecteAt: new Date(),
      statut: courrier.statut === "recu" || courrier.statut === "a_affecter" ? "affecte" : courrier.statut,
    },
  });

  await logAuditCourrier({ courrierEntrantId: id }, "affectation", "succes", `Affecté à ${utilisateur.nom}`);
  return misAJour;
}

const TRANSITIONS_ENTRANT: Record<StatutCourrierEntrant, StatutCourrierEntrant[]> = {
  recu: ["a_affecter", "affecte", "classe"],
  a_affecter: ["affecte", "classe"],
  affecte: ["en_traitement", "classe"],
  en_traitement: ["traite", "classe"],
  traite: ["classe"],
  classe: [],
};

export async function changerStatutCourrierEntrant(
  id: string,
  cabinetId: string,
  nouveauStatut: StatutCourrierEntrant
) {
  const courrier = await prisma.courrierEntrant.findFirst({ where: { id, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");
  if (!TRANSITIONS_ENTRANT[courrier.statut].includes(nouveauStatut)) {
    throw new Error("TRANSITION_INVALIDE");
  }

  const misAJour = await prisma.courrierEntrant.update({
    where: { id },
    data: {
      statut: nouveauStatut,
      ...(nouveauStatut === "classe" ? { classeAt: new Date() } : {}),
    },
  });

  await logAuditCourrier({ courrierEntrantId: id }, "changement_statut", "succes", `${courrier.statut} → ${nouveauStatut}`);
  return misAJour;
}

export async function envoyerCourrierSortant(id: string, cabinetId: string, dateEnvoi?: Date) {
  const courrier = await prisma.courrierSortant.findFirst({ where: { id, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");

  const misAJour = await prisma.courrierSortant.update({
    where: { id },
    data: { statut: "envoye", dateEnvoi: dateEnvoi ?? new Date() },
  });

  await logAuditCourrier({ courrierSortantId: id }, "envoi", "succes", `Envoyé (${misAJour.numero})`);
  return misAJour;
}

export async function classerCourrierSortant(id: string, cabinetId: string) {
  const courrier = await prisma.courrierSortant.findFirst({ where: { id, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");

  const misAJour = await prisma.courrierSortant.update({
    where: { id },
    data: { statut: "classe", classeAt: new Date() },
  });

  await logAuditCourrier({ courrierSortantId: id }, "classement", "succes", `Classé (${misAJour.numero})`);
  return misAJour;
}

// ---------------------------------------------------------------------------
// Lien avec le module Délais existant - reference croisee uniquement,
// AUCUNE duplication du calcul (meme computeDeadline, meme
// syncEvenementDepuisDelaiCalcul que routes/delais.ts).
// ---------------------------------------------------------------------------

export async function creerDelaiDepuisCourrierEntrant(
  courrierId: string,
  cabinetId: string,
  userId: string,
  input: { delaiTypeId: string; dateDepart: Date }
) {
  const courrier = await prisma.courrierEntrant.findFirst({ where: { id: courrierId, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");

  const delaiType = await prisma.delaiType.findFirst({
    where: { id: input.delaiTypeId, cabinetId, actif: true },
  });
  if (!delaiType) throw new Error("TYPE_DELAI_INTROUVABLE");

  const dateLimite = computeDeadline(input.dateDepart, delaiType.nombreUnites, delaiType.unite, delaiType.joursOuvresUniquement);

  const calcul = await prisma.delaiCalcul.create({
    data: {
      delaiTypeId: delaiType.id,
      dossierId: courrier.dossierId,
      dateDepart: input.dateDepart,
      dateLimite,
      createdById: userId,
      courrierEntrantId: courrier.id,
    },
    include: { delaiType: true },
  });

  await syncEvenementDepuisDelaiCalcul(calcul.id);
  await logAuditCourrier(
    { courrierEntrantId: courrierId },
    "delai_cree",
    "succes",
    `Délai "${delaiType.nom}" créé (échéance ${dateLimite.toLocaleDateString("fr-FR")})`
  );

  return calcul;
}

// ---------------------------------------------------------------------------
// Chainage vers une Action existante ("Créer une action" / "Répondre au
// courrier" via une Action plutot qu'un CourrierSortant) - webActions.ts
// reste totalement inchange : cette fonction se contente de poser la
// reference APRES coup, sur une action deja creee par le flux habituel.
// ---------------------------------------------------------------------------

export async function lierActionACourrierEntrant(courrierId: string, cabinetId: string, actionId: string) {
  const courrier = await prisma.courrierEntrant.findFirst({ where: { id: courrierId, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");

  const action = await prisma.action.findFirst({ where: { id: actionId, dossier: { cabinetId } } });
  if (!action) throw new Error("ACTION_INTROUVABLE");
  // Coherence de chainage : si le courrier a deja un dossier, l'action liee
  // doit porter sur CE MEME dossier (sinon la fiche courrier afficherait une
  // action sans rapport reel) - jamais bloquant si le courrier n'a pas
  // encore de dossier (cas normal d'une fiche pas encore completee).
  if (courrier.dossierId && action.dossierId !== courrier.dossierId) {
    throw new Error("ACTION_DOSSIER_DIFFERENT");
  }

  const misAJour = await prisma.action.update({ where: { id: actionId }, data: { courrierEntrantId: courrierId } });

  await logAuditCourrier({ courrierEntrantId: courrierId }, "action_liee", "succes", `Action "${action.nomDocument ?? action.typeAction}" liée`);
  return misAJour;
}

// ---------------------------------------------------------------------------
// Pieces jointes / numerisation - reutilise integralement
// stockageDocuments.ts (chiffrement AES-256-GCM inchange) et l'OCR existant
// (jobs/traitementOcr.ts) DES QUE le courrier a un dossier. Sans dossier,
// stockage temporaire via CourrierPieceJointe (voir schema.prisma pour la
// justification complete) - pas d'OCR tant que cette etape n'est pas faite.
// ---------------------------------------------------------------------------

const DATA_URL_PATTERN = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

export interface UploaderPieceInput {
  nom: string;
  fichierDataUrl: string;
}

function decoderDataUrl(fichierDataUrl: string): { typeMime: string; contenu: Buffer } {
  const match = fichierDataUrl.match(DATA_URL_PATTERN);
  if (!match) throw new Error("FICHIER_INVALIDE");
  const [, typeMime, base64Data] = match;
  const contenu = Buffer.from(base64Data, "base64");
  if (contenu.length === 0) throw new Error("FICHIER_VIDE");
  return { typeMime, contenu };
}

async function uploaderPieceCourrier(
  lien: { courrierEntrantId: string } | { courrierSortantId: string },
  cabinetId: string,
  dossierId: string | null,
  userId: string,
  input: UploaderPieceInput
) {
  const { typeMime, contenu } = decoderDataUrl(input.fichierDataUrl);
  const courrierId = "courrierEntrantId" in lien ? lien.courrierEntrantId : lien.courrierSortantId;

  if (dossierId) {
    // Dossier deja connu : piece jointe reelle, meme table/chiffrement/OCR
    // qu'une piece de dossier ordinaire (source="courrier").
    const { nomFichier, tailleOctets } = await enregistrerFichier(dossierId, contenu);
    const document = await prisma.documentDossier.create({
      data: {
        cabinetId,
        dossierId,
        nomOriginal: input.nom,
        typeMime,
        tailleOctets,
        nomFichier,
        source: "courrier",
        uploadeParId: userId,
        ...lien,
      },
    });
    enqueuerTraitementOcr(document, contenu).catch((error) => {
      console.error(`[courriers] échec du déclenchement OCR pour le document ${document.id} :`, error instanceof Error ? error.message : error);
    });
    await logAuditCourrier(lien, "piece_ajoutee", "succes", `Pièce "${input.nom}" numérisée et rattachée au dossier`);
    return { type: "document" as const, document };
  }

  // Pas encore de dossier : stockage temporaire, sous la cle du courrier
  // lui-meme (voir CourrierPieceJointe dans schema.prisma).
  const { nomFichier, tailleOctets } = await enregistrerFichier(courrierId!, contenu);
  const piece = await prisma.courrierPieceJointe.create({
    data: {
      cabinetId,
      nomOriginal: input.nom,
      typeMime,
      tailleOctets,
      nomFichier,
      uploadeParId: userId,
      ...lien,
    },
  });
  await logAuditCourrier(lien, "piece_ajoutee", "succes", `Pièce "${input.nom}" ajoutée (en attente de dossier pour l'OCR)`);
  return { type: "piece_jointe" as const, piece };
}

export async function uploaderPieceCourrierEntrant(courrierId: string, cabinetId: string, userId: string, input: UploaderPieceInput) {
  const courrier = await prisma.courrierEntrant.findFirst({ where: { id: courrierId, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");
  return uploaderPieceCourrier({ courrierEntrantId: courrierId }, cabinetId, courrier.dossierId, userId, input);
}

export async function uploaderPieceCourrierSortant(courrierId: string, cabinetId: string, userId: string, input: UploaderPieceInput) {
  const courrier = await prisma.courrierSortant.findFirst({ where: { id: courrierId, cabinetId } });
  if (!courrier) throw new Error("COURRIER_INTROUVABLE");
  return uploaderPieceCourrier({ courrierSortantId: courrierId }, cabinetId, courrier.dossierId, userId, input);
}

/**
 * Migration des pieces temporaires (CourrierPieceJointe) vers de vrais
 * DocumentDossier, au moment ou un dossier est enfin rattache au courrier -
 * memes fonctions de stockage, simplement rejouees avec le VRAI dossierId
 * cette fois (voir uploaderPieceCourrier ci-dessus). Chaque piece migree
 * declenche l'OCR existant, exactement comme si elle avait ete uploadee
 * directement sur un courrier deja rattache.
 */
async function migrerPiecesJointesVersDossier(
  cle: "courrierEntrantId" | "courrierSortantId",
  courrierId: string,
  dossierId: string,
  cabinetId: string
) {
  const pieces = await prisma.courrierPieceJointe.findMany({ where: { [cle]: courrierId } });
  for (const piece of pieces) {
    const contenu = await lireFichier(courrierId, piece.nomFichier);
    const { nomFichier, tailleOctets } = await enregistrerFichier(dossierId, contenu);
    const document = await prisma.documentDossier.create({
      data: {
        cabinetId,
        dossierId,
        nomOriginal: piece.nomOriginal,
        typeMime: piece.typeMime,
        tailleOctets,
        nomFichier,
        source: "courrier",
        uploadeParId: piece.uploadeParId,
        [cle]: courrierId,
      },
    });
    enqueuerTraitementOcr(document, contenu).catch((error) => {
      console.error(`[courriers] échec du déclenchement OCR pour le document migré ${document.id} :`, error instanceof Error ? error.message : error);
    });
    await supprimerFichier(courrierId, piece.nomFichier);
    await prisma.courrierPieceJointe.delete({ where: { id: piece.id } });
  }
}
