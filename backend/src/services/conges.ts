import { prisma } from "../lib/prisma";

/**
 * Module RH Cabinet, RH-3 (voir docs/rh/) - types d'absence par defaut,
 * crees UNE SEULE FOIS par cabinet, a la premiere utilisation (pas de hook
 * "activation du module" dans ce projet - voir docs/rh/00-audit.md,
 * modulesDesactives est juste un flag, aucun evenement declenche). Le
 * titulaire peut ensuite les modifier/desactiver librement (TypeAbsence.actif).
 */
const TYPES_ABSENCE_DEFAUT: { libelle: string; decompteSolde: boolean; remunere: boolean; justificatifRequis: boolean }[] = [
  { libelle: "Congé annuel", decompteSolde: true, remunere: true, justificatifRequis: false },
  { libelle: "Maladie", decompteSolde: false, remunere: true, justificatifRequis: true },
  { libelle: "Maternité / paternité", decompteSolde: false, remunere: true, justificatifRequis: true },
  { libelle: "Absence autorisée", decompteSolde: true, remunere: true, justificatifRequis: false },
  { libelle: "Formation", decompteSolde: false, remunere: true, justificatifRequis: false },
  { libelle: "Absence non rémunérée", decompteSolde: false, remunere: false, justificatifRequis: false },
];

export async function ensureTypesAbsenceParDefaut(cabinetId: string): Promise<void> {
  const existants = await prisma.typeAbsence.count({ where: { cabinetId } });
  if (existants > 0) return;
  await prisma.typeAbsence.createMany({
    data: TYPES_ABSENCE_DEFAUT.map((t) => ({ cabinetId, ...t })),
  });
}

function memeJourMoisJour(a: Date, b: Date): boolean {
  return a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

/** Un jour est ferie s'il correspond exactement a une date non-recurrente,
 * OU au mois/jour d'une date recurrente (annee ignoree). */
function estJourFerie(jour: Date, joursFeries: { date: Date; recurrentChaqueAnnee: boolean }[]): boolean {
  return joursFeries.some((f) =>
    f.recurrentChaqueAnnee
      ? memeJourMoisJour(jour, f.date)
      : jour.getUTCFullYear() === f.date.getUTCFullYear() && memeJourMoisJour(jour, f.date)
  );
}

/**
 * Nombre de jours OUVRES entre dateDebut et dateFin inclus, en tenant
 * compte des jours feries du cabinet, du samedi ouvre ou non
 * (Cabinet.rhSamediOuvre), et des demi-journees aux deux bornes (-0.5
 * chacune si le jour concerne est lui-meme un jour ouvre, jamais
 * -0.5 sur un jour deja non-ouvre - une demi-journee posee un samedi non
 * ouvre n'a aucun sens a soustraire).
 */
export function calculerJoursOuvres(
  dateDebut: Date,
  dateFin: Date,
  options: {
    demiJourneeDebut: boolean;
    demiJourneeFin: boolean;
    samediOuvre: boolean;
    joursFeries: { date: Date; recurrentChaqueAnnee: boolean }[];
  }
): number {
  let total = 0;
  const courant = new Date(Date.UTC(dateDebut.getUTCFullYear(), dateDebut.getUTCMonth(), dateDebut.getUTCDate()));
  const fin = new Date(Date.UTC(dateFin.getUTCFullYear(), dateFin.getUTCMonth(), dateFin.getUTCDate()));

  while (courant.getTime() <= fin.getTime()) {
    const jourSemaine = courant.getUTCDay(); // 0=dimanche .. 6=samedi
    const estOuvre = jourSemaine !== 0 && (jourSemaine !== 6 || options.samediOuvre) && !estJourFerie(courant, options.joursFeries);
    if (estOuvre) {
      let valeur = 1;
      if (options.demiJourneeDebut && courant.getTime() === dateDebut.getTime()) valeur -= 0.5;
      if (options.demiJourneeFin && courant.getTime() === fin.getTime()) valeur -= 0.5;
      total += Math.max(0, valeur);
    }
    courant.setUTCDate(courant.getUTCDate() + 1);
  }
  return total;
}

/** Jours deja pris (approuves, decomptes du solde) pour une annee donnee -
 * calcule a la volee depuis DemandeAbsence, jamais duplique dans
 * SoldeConges (voir spec RH, section 4). */
export async function joursPris(fichePersonnelId: string, annee: number): Promise<number> {
  const debutAnnee = new Date(Date.UTC(annee, 0, 1));
  const finAnnee = new Date(Date.UTC(annee, 11, 31, 23, 59, 59));
  const demandes = await prisma.demandeAbsence.findMany({
    where: {
      fichePersonnelId,
      statut: "approuvee",
      dateDebut: { lte: finAnnee },
      dateFin: { gte: debutAnnee },
      typeAbsence: { decompteSolde: true },
    },
    select: { nbJoursOuvres: true },
  });
  return demandes.reduce((total, d) => total + d.nbJoursOuvres, 0);
}
