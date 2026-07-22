import { env } from "../config/env";

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

/**
 * Recherche web via Tavily pour la "recherche juridique" generale (droit,
 * textes, doctrine) - complementaire a la base RAG jurisprudence, qui elle
 * reste strictement limitee aux sources verifiees par le cabinet.
 * Renvoie [] si la cle API est absente ou en cas d'erreur, plutot que de
 * faire planter la generation : le LLM doit alors dire qu'il n'a pas
 * trouve de source, jamais inventer.
 */
export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  if (!env.TAVILY_API_KEY) {
    console.error("TAVILY_API_KEY non configuree, recherche juridique impossible");
    return [];
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        search_depth: "advanced",
        max_results: maxResults,
        include_answer: false,
      }),
    });

    if (!response.ok) {
      console.error("Erreur Tavily :", response.status, await response.text());
      return [];
    }

    const data = (await response.json()) as {
      results?: { title: string; url: string; content: string }[];
    };

    return (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    }));
  } catch (error) {
    console.error("Erreur appel Tavily :", error);
    return [];
  }
}

export function formatWebSearchContext(results: WebSearchResult[]): string {
  if (results.length === 0) {
    return "Aucun resultat de recherche web trouve pour cette question.";
  }
  return results
    .map((r, i) => `[Source ${i + 1}] ${r.title}\nURL : ${r.url}\n${r.content}`)
    .join("\n\n");
}
