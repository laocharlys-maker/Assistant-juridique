export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
}

/**
 * Recherche web via Tavily pour la "recherche juridique" generale (droit,
 * textes, doctrine) - complementaire a la base RAG jurisprudence, qui elle
 * reste strictement limitee aux sources verifiees par le cabinet.
 * Renvoie [] si la cle API est absente ou en cas d'erreur, plutot que de
 * faire planter la generation : le LLM doit alors dire qu'il n'a pas
 * trouve de source, jamais inventer.
 *
 * timeRange restreint Tavily aux pages publiees recemment ("week" pour la
 * veille juridique hebdomadaire, par ex.) - a laisser vide pour la
 * recherche juridique generale, ou une source ancienne (texte de loi,
 * jurisprudence de reference) reste pertinente et ne doit pas etre exclue.
 */
export async function searchWeb(
  query: string,
  maxResults = 5,
  includeDomains?: string[],
  timeRange?: "day" | "week" | "month" | "year"
): Promise<WebSearchResult[]> {
  // process.env directement, pas env.TAVILY_API_KEY (config/env.ts) - voir
  // services/llm/index.ts (resolveLlmProvider) et groq.ts/gemini.ts pour le
  // detail : `env` est un singleton fige au premier chargement du module
  // (envSchema.parse(process.env), une seule fois) - en mode portable
  // (build desktop), TAVILY_API_KEY est pose sur process.env par index.ts
  // (cle bundlee ou .env) potentiellement APRES cette premiere evaluation,
  // ce qui laissait `env.TAVILY_API_KEY` fige a `undefined` pour toute la
  // duree du process, meme une fois la cle correctement presente sur
  // process.env - cause reelle des recherches juridique/jurisprudence ne
  // trouvant jamais aucune source. Une lecture live, refaite a CHAQUE appel,
  // elimine cette classe de bug par construction.
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.error("TAVILY_API_KEY non configuree, recherche juridique impossible");
    return [];
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "advanced",
        max_results: maxResults,
        include_answer: false,
        ...(includeDomains && includeDomains.length > 0 ? { include_domains: includeDomains } : {}),
        ...(timeRange ? { time_range: timeRange } : {}),
      }),
    });

    if (!response.ok) {
      console.error("Erreur Tavily :", response.status, await response.text());
      return [];
    }

    const data = (await response.json()) as {
      results?: { title: string; url: string; content: string; published_date?: string }[];
    };

    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      publishedDate: r.published_date || undefined,
    }));
  } catch (error) {
    console.error("Erreur appel Tavily :", error);
    return [];
  }
}

// Le contenu Tavily (search_depth "advanced") peut atteindre plusieurs
// milliers de caracteres par source. Non tronque, une recherche combinant
// une dizaine de sources depasse a elle seule le quota de tokens/minute des
// fournisseurs LLM a plan gratuit (ex: Groq, 12000 TPM) et fait echouer la
// requete (413 "Request too large"). Un extrait de 500 caracteres reste
// largement suffisant pour que le LLM cite la source et son contenu.
const LONGUEUR_MAX_EXTRAIT = 500;

function tronquerExtrait(content: string): string {
  if (content.length <= LONGUEUR_MAX_EXTRAIT) return content;
  return `${content.slice(0, LONGUEUR_MAX_EXTRAIT)}…`;
}

export function formatWebSearchContext(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return "Aucun resultat de recherche web trouve pour cette question.";
  }
  return results
    .map(
      (r, i) =>
        `[Source ${i + 1}] ${r.title}${r.publishedDate ? ` (publie le ${r.publishedDate})` : ""}\nURL : ${r.url}\n${tronquerExtrait(r.content)}`
    )
    .join("\n\n");
}
