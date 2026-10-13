// Format de date unique utilise partout dans l'app pour l'affichage d'une
// date complete (ex: "dimanche 20 juillet 2026") - jamais le format court
// jour/mois/annee ni le format ISO, reserves aux valeurs machine.
export function formatDateLongue(date: Date, timeZone?: string): string {
  return date.toLocaleDateString("fr-FR", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone });
}

// Format court unique JJ-MM-AAAA (demande utilisateur du 2026-10-13, voir
// l'equivalent cote navigateur public/js/layout.js, formatDateCourte) -
// jamais JJ/MM/AAAA (toLocaleDateString par defaut) ni AAAA-MM-JJ (ISO).
// A utiliser pour toute date courte inseree dans un message/titre genere
// cote serveur (ex: contenu d'une Notification).
export function formatDateCourteFr(date: Date, timeZone?: string): string {
  const jj = date.toLocaleDateString("fr-FR", { day: "2-digit", timeZone });
  const mm = date.toLocaleDateString("fr-FR", { month: "2-digit", timeZone });
  const aaaa = date.toLocaleDateString("fr-FR", { year: "numeric", timeZone });
  return `${jj}-${mm}-${aaaa}`;
}
