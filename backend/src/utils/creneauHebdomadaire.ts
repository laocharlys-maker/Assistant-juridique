/**
 * Rattrapage au demarrage (voir services/veilleJuridique.ts,
 * services/roleSemaineRecap.ts, index.ts) : calcule en UTC pur le dernier
 * creneau hebdomadaire deja passe (ex: "le dernier lundi 7h heure du
 * Benin"), pour le comparer a un horodatage de derniere execution deja
 * enregistre en base.
 *
 * Benin (Africa/Porto-Novo) : UTC+1 fixe, aucune heure d'ete - permet ce
 * calcul en UTC pur, sans dependance a une bibliotheque de fuseaux horaires
 * (le projet evite deliberement les dependances tierces evitables, voir
 * security/machineFingerprint.ts). index.ts utilise separement
 * `{ timezone: "Africa/Porto-Novo" }` (node-cron) pour determiner QUAND ces
 * heures locales tombent en pratique - ce module recalcule les MEMES
 * instants en UTC pour comparaison, jamais une deuxieme source de verite
 * independante.
 */

/** Le dernier instant (jourSemaineUtc, heureUtc en UTC) deja passe par
 * rapport a `maintenant` - jourSemaineUtc suit la convention de
 * Date.getUTCDay() (0 = dimanche ... 6 = samedi). */
export function dernierCreneauPasse(maintenant: Date, jourSemaineUtc: number, heureUtc: number): Date {
  const candidat = new Date(
    Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate(), heureUtc, 0, 0, 0)
  );
  const decalageJours = (candidat.getUTCDay() - jourSemaineUtc + 7) % 7;
  candidat.setUTCDate(candidat.getUTCDate() - decalageJours);
  if (candidat.getTime() > maintenant.getTime()) {
    candidat.setUTCDate(candidat.getUTCDate() - 7);
  }
  return candidat;
}

// Lundi 7h heure du Benin = lundi 6h UTC (voir index.ts, cron.schedule("0 7 * * 1", ...)).
export function dernierCreneauVeilleJuridique(maintenant: Date): Date {
  return dernierCreneauPasse(maintenant, 1, 6);
}

// Vendredi 8h heure du Benin = vendredi 7h UTC (voir index.ts, cron.schedule("0 8 * * 5", ...)).
export function dernierCreneauRoleSemaine(maintenant: Date): Date {
  return dernierCreneauPasse(maintenant, 5, 7);
}
