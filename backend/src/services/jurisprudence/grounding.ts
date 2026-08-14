import { JurisprudenceMatch } from "../rag";
import { WebSearchResult } from "../tavily";
import { verifierLien, VerificationLien } from "./verifierLien";

/**
 * Lot 13 - grounding strict + liens reels pour le module jurisprudence.
 *
 * Detection des citations : le prompt systeme (voir prompts/webRedaction.ts,
 * JURISPRUDENCE_SYSTEM_PROMPT) impose au LLM de faire suivre chaque decision
 * citee du marqueur exact `[REF: Source N]`, ou N est l'index EXACT (1-base)
 * de la source correspondante dans la liste numerotee fournie dans le
 * prompt (voir construireSourcesDisponibles/formatSourcesPourPrompt
 * ci-dessous). La correspondance est donc purement structurelle (recherche
 * de sources[N-1] par index), jamais une comparaison approximative de texte
 * qui risquerait de valider une hallucination proche d'une vraie reference -
 * plus fiable qu'une regex sur texte libre (voir contrainte du prompt).
 */

export type OrigineSource = "cabinet" | "web";

export interface SourceDisponible {
  /** Index 1-base tel qu'annonce au LLM dans le prompt ("[Source N]"). */
  index: number;
  origine: OrigineSource;
  reference: string;
  juridiction: string | null;
  date: string | null;
  lien: string | null;
  /** Extrait de contenu inclus dans le prompt (jamais utilise pour le
   * grounding lui-meme, uniquement pour reconstruire le texte source). */
  extrait: string;
  /** Categorie Tavily d'origine (benin/ohada/france/afrique_francophone/
   * ouvert) pour une source web - null pour une source cabinet, ou si
   * l'appelant ne la fournit pas (voir rechercheTavily.ts). Champ interne
   * uniquement : jamais inclus dans formatSourcesPourPrompt() (jamais
   * expose au LLM autrement que via le classement deja present dans
   * l'ordre des sources). */
  categorieWeb: string | null;
}

export interface SourceValidee {
  reference: string;
  juridiction: string | null;
  date: string | null;
  lien: string;
  origine: OrigineSource;
}

export type MotifRejetCitation = "hallucination" | "lien_manquant" | "lien_inaccessible";

export interface CitationRejetee {
  /** null si le numero cite ne correspond a aucune source (hallucination pure). */
  reference: string | null;
  motif: MotifRejetCitation;
}

export interface ResultatGrounding {
  /** Texte pret a afficher : marqueurs [REF: ...] retires, URLs brutes
   * produites par le LLM neutralisees (defense en profondeur - voir
   * README-LOT13.md), avertissement ajoute si au moins une citation a ete
   * retiree. */
  texte: string;
  sourcesValidees: SourceValidee[];
  rejets: CitationRejetee[];
}

const REF_PATTERN = /\[REF:\s*Source\s+(\d+)\]/gi;
const URL_PATTERN = /https?:\/\/\S+/gi;

/** Construit la liste unifiee et numerotee des sources effectivement
 * recuperees (base RAG du cabinet, puis resultats Tavily) - une seule
 * numerotation continue, jamais deux listes qui redemarreraient chacune a
 * 1 (risque de collision d'index entre "Source 1" cabinet et "Source 1"
 * web). Ne modifie ni ne recalcule rien : lit tel quel ce que
 * searchJurisprudence()/searchWeb() ont deja recupere. */
export function construireSourcesDisponibles(
  cabinetMatches: JurisprudenceMatch[],
  webResults: (WebSearchResult & { categorie?: string })[]
): SourceDisponible[] {
  const sources: SourceDisponible[] = [];
  let index = 1;
  for (const m of cabinetMatches) {
    sources.push({
      index: index++,
      origine: "cabinet",
      reference: m.reference,
      juridiction: m.juridiction,
      date: m.dateDecision,
      lien: m.lien,
      extrait: m.contenu,
      categorieWeb: null,
    });
  }
  for (const r of webResults) {
    sources.push({
      index: index++,
      origine: "web",
      reference: r.title,
      juridiction: null,
      date: r.publishedDate ?? null,
      lien: r.url,
      extrait: r.content,
      categorieWeb: r.categorie ?? null,
    });
  }
  return sources;
}

/** Formate la liste unifiee pour le prompt utilisateur - utilisee par la
 * Recherche de jurisprudence ET la Recherche juridique generale (meme
 * grounding Lot 13 pour les deux, voir routes/webActions.ts). La Veille
 * juridique a son propre formateur, sans grounding (voir
 * services/veilleJuridiqueUtils.ts, formatSourcesVeillePourPrompt). */
export function formatSourcesPourPrompt(sources: SourceDisponible[]): string {
  if (sources.length === 0) {
    return "Aucune source recuperee pour cette recherche.";
  }
  return sources
    .map((s) => {
      const meta =
        s.origine === "cabinet"
          ? `${s.juridiction ?? "juridiction non précisée"}${s.date ? `, ${s.date}` : ""} — base du cabinet`
          : `source web${s.date ? ` (publiée le ${s.date})` : ""}`;
      return `[Source ${s.index}] ${s.reference} (${meta})\n${s.extrait}`;
    })
    .join("\n\n");
}

function logRejet(rejet: CitationRejetee): void {
  // Jamais de donnee client sensible ici : uniquement la reference publique
  // de la decision (ou null) et le motif - voir "bonnes pratiques" du prompt.
  console.log(`[jurisprudence-grounding] citation rejetée (${rejet.motif}) :`, rejet.reference ?? "(source inexistante)");
}

/**
 * Valide et filtre les citations d'une reponse LLM par rapport aux sources
 * effectivement recuperees pour cette requete precise. Ne bloque jamais la
 * reponse : un texte sans aucune citation valide reste affiche tel quel
 * (moins l'avertissement, ajoute seulement s'il y a eu au moins un rejet).
 */
export async function validerEtFiltrerCitations(
  texteLlm: string,
  sourcesDisponibles: SourceDisponible[],
  verifierLienFn: (url: string) => Promise<VerificationLien> = verifierLien
): Promise<ResultatGrounding> {
  const indexCites = new Set<number>();
  for (const match of texteLlm.matchAll(REF_PATTERN)) {
    indexCites.add(Number(match[1]));
  }

  const decisions = new Map<number, { source: SourceDisponible | null; motif: MotifRejetCitation | null }>();
  const aVerifier: { index: number; source: SourceDisponible }[] = [];

  for (const index of indexCites) {
    const source = sourcesDisponibles.find((s) => s.index === index) ?? null;
    if (!source) {
      decisions.set(index, { source: null, motif: "hallucination" });
      logRejet({ reference: null, motif: "hallucination" });
      continue;
    }
    if (!source.lien) {
      decisions.set(index, { source, motif: "lien_manquant" });
      logRejet({ reference: source.reference, motif: "lien_manquant" });
      continue;
    }
    aVerifier.push({ index, source });
  }

  // Verification d'accessibilite en parallele - uniquement les sources
  // reellement citees (jamais toutes les sources recuperees), jamais en
  // sequence (contrainte de performance du prompt).
  await Promise.all(
    aVerifier.map(async ({ index, source }) => {
      const resultat = await verifierLienFn(source.lien!);
      if (resultat.accessible) {
        decisions.set(index, { source, motif: null });
      } else {
        decisions.set(index, { source, motif: "lien_inaccessible" });
        logRejet({ reference: source.reference, motif: "lien_inaccessible" });
      }
    })
  );

  let texte = texteLlm.replace(REF_PATTERN, (_match, indexStr: string) => {
    const decision = decisions.get(Number(indexStr));
    return decision && !decision.motif ? "" : " *(référence non vérifiée)*";
  });
  // Defense en profondeur : le prompt systeme interdit au LLM de produire
  // un lien, mais le texte genere ne doit JAMAIS etre une source de confiance
  // pour un lien affiche - toute URL brute qui y apparaitrait quand meme est
  // neutralisee. Les liens affiches viennent uniquement des SourceValidee
  // ci-dessous, jamais de ce texte.
  texte = texte.replace(URL_PATTERN, "[lien retiré]");

  const sourcesValidees: SourceValidee[] = [];
  const rejets: CitationRejetee[] = [];
  for (const decision of decisions.values()) {
    if (!decision.motif && decision.source) {
      sourcesValidees.push({
        reference: decision.source.reference,
        juridiction: decision.source.juridiction,
        date: decision.source.date,
        lien: decision.source.lien!,
        origine: decision.source.origine,
      });
    } else if (decision.motif) {
      rejets.push({ reference: decision.source?.reference ?? null, motif: decision.motif });
    }
  }

  if (rejets.length > 0) {
    texte += "\n\n> ⚠️ Une partie de l'analyse n'a pas pu être sourcée avec un lien vérifié.";
  }

  return { texte, sourcesValidees, rejets };
}
