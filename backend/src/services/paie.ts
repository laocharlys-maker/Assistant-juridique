import { prisma } from "../lib/prisma";
import { calculerJoursOuvres } from "./conges";

/**
 * Module RH Cabinet, RH-5 (voir docs/rh/) - calcul d'une fiche de paie,
 * tout en entiers FCFA (decision du 13/10/2026 : montants en clair en
 * base, pas de chiffrement - voir docs/rh/00-audit.md question 3).
 *
 * brut        = Σ gains fixes + Σ gains variables du mois
 * retenues    = Σ retenues fixes + Σ retenues variables + retenue d'absence
 *               non remuneree
 * net a payer = brut - retenues (jamais negatif - refuse avec une erreur
 *               claire, voir routes/paie.ts)
 *
 * Arrondi au franc le plus proche, APPLIQUE LIGNE PAR LIGNE (pas sur le
 * total), pour que la somme affichee corresponde exactement a la somme des
 * lignes affichees sur le PDF.
 */

export class NetNegatifError extends Error {
  constructor() {
    super("NET_NEGATIF");
  }
}

export interface LigneCalculee {
  sens: "gain" | "retenue";
  libelle: string;
  base: number | null;
  taux: number | null;
  montant: number;
}

export interface ResultatCalcul {
  lignes: LigneCalculee[];
  brut: number;
  totalRetenues: number;
  net: number;
}

function moisVersBornes(mois: string): { debut: Date; fin: Date } {
  const [annee, moisNum] = mois.split("-").map(Number);
  const debut = new Date(Date.UTC(annee, moisNum - 1, 1));
  const fin = new Date(Date.UTC(annee, moisNum, 0, 23, 59, 59));
  return { debut, fin };
}

export async function calculerFichePaie(fichePersonnelId: string, mois: string): Promise<ResultatCalcul> {
  const { debut, fin } = moisVersBornes(mois);

  const fiche = await prisma.fichePersonnel.findUniqueOrThrow({ where: { id: fichePersonnelId }, select: { cabinetId: true } });

  const [elements, ajustements, cabinet, joursFeries] = await Promise.all([
    prisma.elementSalaire.findMany({
      where: {
        fichePersonnelId,
        actif: true,
        dateDebut: { lte: fin },
        OR: [{ dateFin: null }, { dateFin: { gte: debut } }],
      },
    }),
    prisma.ajustementMensuel.findMany({ where: { fichePersonnelId, periodePaie: { mois } } }),
    prisma.cabinet.findUnique({ where: { id: fiche.cabinetId }, select: { rhSamediOuvre: true } }),
    prisma.jourFerie.findMany({ where: { cabinetId: fiche.cabinetId }, select: { date: true, recurrentChaqueAnnee: true } }),
  ]);

  const salaireBaseElement = elements.find((e) => e.estSalaireBase);
  const salaireBase = salaireBaseElement?.valeur ?? 0;

  const lignes: LigneCalculee[] = [];

  // Premiere passe : tout ce qui n'est PAS un pourcentage base sur "brut"
  // (montant fixe, et pourcentage base sur salaire_base - connu d'avance).
  // Necessaire pour pouvoir calculer ensuite les pourcentages bases sur
  // "brut" a partir d'un brut déjà connu.
  const elementsPourcentageBrut = elements.filter((e) => e.modeCalcul === "pourcentage" && e.baseCalcul === "brut");
  const elementsRestants = elements.filter((e) => !elementsPourcentageBrut.includes(e));

  for (const e of elementsRestants) {
    const montant =
      e.modeCalcul === "montant_fixe" ? e.valeur : Math.round((salaireBase * e.valeur) / 100);
    lignes.push({
      sens: e.sens as "gain" | "retenue",
      libelle: e.libelle,
      base: e.modeCalcul === "pourcentage" ? salaireBase : null,
      taux: e.modeCalcul === "pourcentage" ? e.valeur : null,
      montant,
    });
  }

  for (const a of ajustements) {
    lignes.push({ sens: a.sens as "gain" | "retenue", libelle: a.libelle, base: null, taux: null, montant: a.montant });
  }

  const brutProvisoire = lignes.filter((l) => l.sens === "gain").reduce((s, l) => s + l.montant, 0);

  for (const e of elementsPourcentageBrut) {
    const montant = Math.round((brutProvisoire * e.valeur) / 100);
    lignes.push({ sens: e.sens as "gain" | "retenue", libelle: e.libelle, base: brutProvisoire, taux: e.valeur, montant });
  }

  // Retenue d'absence non remuneree (spec section 5.4) : salaire de base /
  // jours ouvres du mois * jours d'absence non remuneree du mois. Limite
  // assumee (V1) : seules les demandes ENTIEREMENT comprises dans ce mois
  // sont comptees - une demande a cheval sur deux mois n'est pas repartie.
  const joursOuvresDuMois = calculerJoursOuvres(debut, fin, {
    demiJourneeDebut: false,
    demiJourneeFin: false,
    samediOuvre: cabinet?.rhSamediOuvre ?? false,
    joursFeries,
  });
  if (joursOuvresDuMois > 0 && salaireBase > 0) {
    const demandesNonRemunerees = await prisma.demandeAbsence.findMany({
      where: {
        fichePersonnelId,
        statut: "approuvee",
        dateDebut: { gte: debut },
        dateFin: { lte: fin },
        typeAbsence: { remunere: false },
      },
      select: { nbJoursOuvres: true },
    });
    const joursAbsenceNonRemuneree = demandesNonRemunerees.reduce((s, d) => s + d.nbJoursOuvres, 0);
    if (joursAbsenceNonRemuneree > 0) {
      const montant = Math.round((salaireBase / joursOuvresDuMois) * joursAbsenceNonRemuneree);
      lignes.push({ sens: "retenue", libelle: "Absence non rémunérée", base: salaireBase, taux: null, montant });
    }
  }

  const brut = lignes.filter((l) => l.sens === "gain").reduce((s, l) => s + l.montant, 0);
  const totalRetenues = lignes.filter((l) => l.sens === "retenue").reduce((s, l) => s + l.montant, 0);
  const net = brut - totalRetenues;

  if (net < 0) throw new NetNegatifError();

  return { lignes, brut, totalRetenues, net };
}

/**
 * Recalcule et PERSISTE les lignes + totaux d'une FichePaie encore en
 * brouillon - appelee a la creation de la periode et a chaque ajout/retrait
 * d'AjustementMensuel. Jamais appelee sur une fiche validee (verifie par
 * l'appelant, voir routes/paie.ts) : une fiche figee ne doit plus jamais
 * etre recalculee.
 */
export async function recalculerEtEnregistrer(fichePaieId: string, fichePersonnelId: string, mois: string): Promise<ResultatCalcul> {
  const resultat = await calculerFichePaie(fichePersonnelId, mois);

  await prisma.$transaction([
    prisma.fichePaieLigne.deleteMany({ where: { fichePaieId } }),
    prisma.fichePaieLigne.createMany({
      data: resultat.lignes.map((l, index) => ({
        fichePaieId,
        ordre: index,
        sens: l.sens,
        libelle: l.libelle,
        base: l.base,
        taux: l.taux,
        montant: l.montant,
      })),
    }),
    prisma.fichePaie.update({
      where: { id: fichePaieId },
      data: { brut: resultat.brut, totalRetenues: resultat.totalRetenues, net: resultat.net },
    }),
  ]);

  return resultat;
}
