// Format de date unique utilise partout dans l'app pour l'affichage d'une
// date complete (ex: "dimanche 20 juillet 2026") - jamais le format court
// jour/mois/annee ni le format ISO, reserves aux valeurs machine.
export function formatDateLongue(date: Date, timeZone?: string): string {
  return date.toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone });
}
