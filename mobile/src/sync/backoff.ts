/**
 * Délais croissants entre deux tentatives d'envoi (Prompt 6, objectif C) -
 * "jamais de boucle serrée" : après chaque échec, on attend de plus en plus
 * longtemps avant de réessayer CET élément précis, plafonné à 15 minutes.
 * Fonction pure, sans dépendance - testable isolément (machine d'états).
 */

const PALIERS_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000];

export function delaiAvantProchaineTentativeMs(nombreTentatives: number): number {
  const index = Math.min(Math.max(nombreTentatives, 0), PALIERS_MS.length - 1);
  return PALIERS_MS[index];
}

/** true si l'élément peut être retenté MAINTENANT (jamais avant sa
 * prochaineTentativeAt) - undefined/null = jamais encore tenté, retente
 * immédiatement. */
export function peutRetenterMaintenant(prochaineTentativeAt: string | null | undefined, maintenant = Date.now()): boolean {
  if (!prochaineTentativeAt) return true;
  return new Date(prochaineTentativeAt).getTime() <= maintenant;
}

export function calculerProchaineTentativeAt(nombreTentatives: number, maintenant = Date.now()): string {
  return new Date(maintenant + delaiAvantProchaineTentativeMs(nombreTentatives)).toISOString();
}
