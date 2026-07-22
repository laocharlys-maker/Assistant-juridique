// Module deterministe de calcul de delais de procedure (pas d'IA).
// Regle de computation appliquee (convention classique en procedure civile
// francophone) : le jour de depart n'est pas compte ("dies a quo non
// computatur"), et si la date obtenue tombe un samedi ou un dimanche, elle
// est reportee au premier jour ouvre suivant.
// NB : les jours feries beninois ne sont pas geres en v1 — le cabinet doit
// verifier manuellement dans ce cas.

export type UniteDelai = "jours" | "mois";

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function nextJourOuvre(date: Date): Date {
  const result = new Date(date);
  while (isWeekend(result)) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
  return result;
}

export function computeDeadline(
  dateDepart: Date,
  nombreUnites: number,
  unite: UniteDelai,
  joursOuvresUniquement: boolean
): Date {
  // On travaille en UTC pour eviter les decalages de fuseau horaire.
  const depart = new Date(
    Date.UTC(dateDepart.getUTCFullYear(), dateDepart.getUTCMonth(), dateDepart.getUTCDate())
  );

  let echeance: Date;
  if (unite === "jours") {
    echeance = new Date(depart);
    echeance.setUTCDate(echeance.getUTCDate() + nombreUnites);
  } else {
    // Delai en mois : meme quantieme dans le mois cible ("du quantieme au
    // quantieme"). Si ce jour n'existe pas dans le mois cible (ex: 31
    // fevrier), on prend le dernier jour de ce mois.
    const targetMonthIndex = depart.getUTCMonth() + nombreUnites;
    const targetYear = depart.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
    const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const day = Math.min(depart.getUTCDate(), lastDayOfTargetMonth);
    echeance = new Date(Date.UTC(targetYear, targetMonth, day));
  }

  if (joursOuvresUniquement) {
    echeance = nextJourOuvre(echeance);
  }

  return echeance;
}
