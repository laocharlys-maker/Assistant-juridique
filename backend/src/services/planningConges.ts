import { prisma } from "../lib/prisma";
import { calculerJoursOuvres } from "./conges";

/**
 * Module RH Cabinet, RH-4 (voir docs/rh/) - planning de conges automatique,
 * regles deterministes SANS IA (voir spec section 5.3). L'algorithme
 * PROPOSE, il ne garantit pas l'optimum - le titulaire garde le dernier
 * mot (brouillon modifiable, jamais de placement force).
 */

export interface ParametresPlanning {
  effectifMin: number;
  periodesBloquees: { debut: string; fin: string }[];
}

export interface LignePlacement {
  fichePersonnelId: string;
  dateDebut: Date | null;
  dateFin: Date | null;
  nbJoursOuvres: number;
  origine: "souhait_1" | "souhait_2" | "souhait_3" | "ajuste_auto" | "non_place";
  raison: string | null;
}

const MS_JOUR = 24 * 60 * 60 * 1000;

function joursEntre(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_JOUR);
}

function chevauchent(debutA: Date, finA: Date, debutB: Date, finB: Date): boolean {
  return debutA.getTime() <= finB.getTime() && finA.getTime() >= debutB.getTime();
}

/**
 * Rotation d'equite "d'une annee sur l'autre" (spec section 5.3, point 1) :
 * sans historique d'ordre stocke, on decale deterministement le point de
 * depart de la liste (triee par anciennete) d'un cran par annee ecoulee
 * depuis une epoque fixe - jamais le meme employe traite en premier deux
 * annees de suite, sans avoir besoin de relire le planning precedent.
 */
function ordonnerAvecRotation<T>(liste: T[], annee: number): T[] {
  if (liste.length === 0) return liste;
  const decalage = ((annee % liste.length) + liste.length) % liste.length;
  return [...liste.slice(decalage), ...liste.slice(0, decalage)];
}

export async function genererPlanning(
  cabinetId: string,
  annee: number,
  parametres: ParametresPlanning
): Promise<LignePlacement[]> {
  const [fichesActives, cabinet, joursFeries] = await Promise.all([
    prisma.fichePersonnel.findMany({
      where: { cabinetId, statut: "actif" },
      select: { id: true, userId: true, dateEntree: true },
      orderBy: { dateEntree: "asc" }, // plus ancien d'abord
    }),
    prisma.cabinet.findUnique({ where: { id: cabinetId }, select: { rhSamediOuvre: true } }),
    prisma.jourFerie.findMany({ where: { cabinetId }, select: { date: true, recurrentChaqueAnnee: true } }),
  ]);
  const samediOuvre = cabinet?.rhSamediOuvre ?? false;

  const ordre = ordonnerAvecRotation(fichesActives, annee);

  const souhaitsParFiche = new Map<string, { rang: number; dateDebut: Date; dateFin: Date }[]>();
  const souhaits = await prisma.souhaitConges.findMany({ where: { fichePersonnelId: { in: ordre.map((f) => f.id) }, annee } });
  for (const s of souhaits) {
    const liste = souhaitsParFiche.get(s.fichePersonnelId) ?? [];
    liste.push({ rang: s.rang, dateDebut: s.dateDebut, dateFin: s.dateFin });
    souhaitsParFiche.set(s.fichePersonnelId, liste);
  }

  // Audiences connues par avocat (userId) - Dossier.avocatResponsableId,
  // via RoleAudience.dateAudience - a eviter dans le placement (spec
  // section 5.3, "entrees"). Chargees une seule fois pour toute l'annee.
  const debutAnnee = new Date(Date.UTC(annee, 0, 1));
  const finAnnee = new Date(Date.UTC(annee, 11, 31));
  const audiences = await prisma.roleAudience.findMany({
    where: {
      dateAudience: { gte: debutAnnee, lte: finAnnee },
      dossier: { avocatResponsableId: { not: null }, cabinetId },
    },
    select: { dateAudience: true, dossier: { select: { avocatResponsableId: true } } },
  });
  const audiencesParAvocat = new Map<string, Date[]>();
  for (const a of audiences) {
    const avocatId = a.dossier?.avocatResponsableId;
    if (!avocatId) continue;
    const liste = audiencesParAvocat.get(avocatId) ?? [];
    liste.push(a.dateAudience);
    audiencesParAvocat.set(avocatId, liste);
  }

  // Absences deja placees DANS CE RUN (cumulatif, ordre de traitement) -
  // utilise pour le controle d'effectif minimum.
  const placements: { fichePersonnelId: string; dateDebut: Date; dateFin: Date }[] = [];

  function effectifOkPourPeriode(debut: Date, fin: Date, excluFicheId: string): boolean {
    const total = fichesActives.length;
    for (let jour = new Date(debut); jour.getTime() <= fin.getTime(); jour.setUTCDate(jour.getUTCDate() + 1)) {
      const absentsCeJour = placements.filter(
        (p) => p.fichePersonnelId !== excluFicheId && chevauchent(p.dateDebut, p.dateFin, jour, jour)
      ).length;
      if (total - absentsCeJour - 1 < parametres.effectifMin) return false;
    }
    return true;
  }

  function periodeBloqueeOk(debut: Date, fin: Date): boolean {
    return !parametres.periodesBloquees.some((p) => chevauchent(debut, fin, new Date(p.debut), new Date(p.fin)));
  }

  function conflitAudience(debut: Date, fin: Date, userId: string | null): boolean {
    if (!userId) return false;
    const dates = audiencesParAvocat.get(userId);
    if (!dates) return false;
    return dates.some((d) => d.getTime() >= debut.getTime() && d.getTime() <= fin.getTime());
  }

  function periodeValide(debut: Date, fin: Date, ficheId: string, userId: string | null): boolean {
    return periodeBloqueeOk(debut, fin) && !conflitAudience(debut, fin, userId) && effectifOkPourPeriode(debut, fin, ficheId);
  }

  const resultats: LignePlacement[] = [];

  for (const fiche of ordre) {
    const souhaitsFiche = (souhaitsParFiche.get(fiche.id) ?? []).sort((a, b) => a.rang - b.rang);
    let place: LignePlacement | null = null;

    for (const s of souhaitsFiche) {
      if (periodeValide(s.dateDebut, s.dateFin, fiche.id, fiche.userId)) {
        const nb = calculerJoursOuvres(s.dateDebut, s.dateFin, { demiJourneeDebut: false, demiJourneeFin: false, samediOuvre, joursFeries });
        place = {
          fichePersonnelId: fiche.id,
          dateDebut: s.dateDebut,
          dateFin: s.dateFin,
          nbJoursOuvres: nb,
          origine: (`souhait_${s.rang}` as LignePlacement["origine"]),
          raison: null,
        };
        break;
      }
    }

    if (!place && souhaitsFiche.length > 0) {
      // Aucun souhait tel quel n'est valide - cherche la plage la plus
      // proche (meme duree que le souhait de rang 1) par decalage croissant,
      // alternant apres/avant (spec section 5.3, etape 4).
      const base = souhaitsFiche[0];
      const dureeJours = joursEntre(base.dateDebut, base.dateFin) + 1;
      const MAX_DECALAGE = 60;
      for (let decalage = 1; decalage <= MAX_DECALAGE && !place; decalage++) {
        for (const sens of [1, -1]) {
          const offset = decalage * sens;
          const debutCandidat = new Date(base.dateDebut.getTime() + offset * MS_JOUR);
          const finCandidat = new Date(debutCandidat.getTime() + (dureeJours - 1) * MS_JOUR);
          if (periodeValide(debutCandidat, finCandidat, fiche.id, fiche.userId)) {
            const nb = calculerJoursOuvres(debutCandidat, finCandidat, { demiJourneeDebut: false, demiJourneeFin: false, samediOuvre, joursFeries });
            place = {
              fichePersonnelId: fiche.id,
              dateDebut: debutCandidat,
              dateFin: finCandidat,
              nbJoursOuvres: nb,
              origine: "ajuste_auto",
              raison: `Décalé de ${decalage} jour${decalage > 1 ? "s" : ""} ${sens > 0 ? "après" : "avant"} le souhait n°1 : effectif minimum ou audience non respecté sur la période demandée.`,
            };
            break;
          }
        }
      }
    }

    if (!place) {
      place = {
        fichePersonnelId: fiche.id,
        dateDebut: null,
        dateFin: null,
        nbJoursOuvres: 0,
        origine: "non_place",
        raison: souhaitsFiche.length === 0 ? "Aucun souhait soumis." : "Aucune plage valide trouvée à proximité des souhaits soumis.",
      };
    }

    if (place.dateDebut && place.dateFin) {
      placements.push({ fichePersonnelId: fiche.id, dateDebut: place.dateDebut, dateFin: place.dateFin });
    }
    resultats.push(place);
  }

  return resultats;
}
