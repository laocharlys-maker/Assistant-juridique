import { formatDateLongue } from "../utils/dateFormat";
import { WebSearchResult, tronquerExtrait } from "./tavily";

export function splitSujets(sujetsBruts: string): string[] {
  return sujetsBruts
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function periodeLabel(now = new Date()): string {
  const debut = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return `${formatDateLongue(debut)} au ${formatDateLongue(now)}`;
}

// La veille doit etre strictement limitee aux 7 derniers jours - un
// resultat sans date de publication exploitable, ou dont la date tombe
// avant J-7, ne doit jamais atteindre le prompt (jamais laisser le LLM
// deviner la fraicheur depuis le texte brut, non fiable). "recent" est
// deliberement conservateur : une date de publication absente OU
// invalide/imparsable est traitee comme non recente (JAMAIS presumee
// recente par defaut).
export function estPublicationRecente(publishedDate: string | undefined, maintenant: Date, joursMax = 7): boolean {
  if (!publishedDate) return false;
  const date = new Date(publishedDate);
  if (Number.isNaN(date.getTime())) return false;
  const seuil = new Date(maintenant.getTime() - joursMax * 24 * 60 * 60 * 1000);
  return date.getTime() >= seuil.getTime();
}

export interface FiltrageResultatsVeille {
  retenus: WebSearchResult[];
  recus: number;
  apresFiltrage: number;
}

/** Filtre les resultats Tavily d'UN theme par date de publication - jamais
 * applique entre themes (chaque theme est filtre independamment, voir
 * services/veilleJuridique.ts). */
export function filtrerResultatsRecents(
  resultats: WebSearchResult[],
  maintenant: Date,
  joursMax = 7
): FiltrageResultatsVeille {
  const retenus = resultats.filter((r) => estPublicationRecente(r.publishedDate, maintenant, joursMax));
  return { retenus, recus: resultats.length, apresFiltrage: retenus.length };
}

// Format JJ-MM-AAAA (jamais l'ISO AAAA-MM-JJ ni le format long de
// formatDateLongue) - lisible directement par un cabinet francophone dans
// un marqueur de source compact, sans ambiguite avec le format americain
// MM/JJ/AAAA. Composantes UTC (jamais locales) : coherent avec
// estPublicationRecente ci-dessus, qui compare deja sur l'horodatage UTC.
function dateJourMoisAnnee(publishedDate: string): string {
  const date = new Date(publishedDate);
  const jour = String(date.getUTCDate()).padStart(2, "0");
  const mois = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${jour}-${mois}-${date.getUTCFullYear()}`;
}

/** Formate les sources DEJA FILTREES (voir filtrerResultatsRecents) pour le
 * prompt utilisateur de la veille - chaque source affiche explicitement sa
 * date de publication au format structure "JJ-MM-AAAA" (jamais a deviner
 * depuis le texte, voir VEILLE_JURIDIQUE_SYSTEM_PROMPT), ainsi que son URL -
 * necessaire pour que l'email hebdomadaire (buildVeilleEmailHtml) puisse
 * toujours citer un lien cliquable vers la source, comme avant ce
 * changement. N'appelle jamais ceci sur des resultats non filtres :
 * publishedDate est suppose toujours present et valide a ce stade. */
export function formatSourcesVeillePourPrompt(resultats: WebSearchResult[]): string {
  if (resultats.length === 0) {
    return "Aucun résultat récent (derniers 7 jours) disponible pour ce thème.";
  }
  return resultats
    .map(
      (r, i) =>
        `[Source ${i + 1}] — publié le ${dateJourMoisAnnee(r.publishedDate!)} — ${r.title} — ${r.url} — ${tronquerExtrait(r.content)}`
    )
    .join("\n\n");
}
