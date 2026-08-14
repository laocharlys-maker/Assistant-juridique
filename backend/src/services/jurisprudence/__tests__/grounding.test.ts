import { describe, it, expect, vi } from "vitest";
import {
  construireSourcesDisponibles,
  formatSourcesPourPrompt,
  validerEtFiltrerCitations,
  SourceDisponible,
} from "../grounding";
import { JurisprudenceMatch } from "../../rag";
import { WebSearchResult } from "../../tavily";
import { VerificationLien } from "../verifierLien";

function accessible(): Promise<VerificationLien> {
  return Promise.resolve({ accessible: true, statut: 200, verifieA: Date.now() });
}
function inaccessible(): Promise<VerificationLien> {
  return Promise.resolve({ accessible: false, statut: 404, verifieA: Date.now() });
}

const cabinetMatch: JurisprudenceMatch = {
  id: "c1",
  source: "Cour Suprême du Bénin",
  reference: "Arrêt n° 12/2024",
  juridiction: "Cour Suprême",
  dateDecision: "2024-03-15",
  contenu: "Texte de la décision...",
  lien: "https://coursupreme.bj/arret-12-2024",
  distance: 0.1,
};

const cabinetMatchSansLien: JurisprudenceMatch = {
  ...cabinetMatch,
  id: "c2",
  reference: "Arrêt n° 99/2020",
  lien: null,
};

const webResult: WebSearchResult = {
  title: "CCJA, Arrêt n° 45/2023",
  url: "https://juricaf.org/arret-45-2023",
  content: "Résumé de l'arrêt CCJA...",
  publishedDate: "2023-06-01",
};

describe("construireSourcesDisponibles", () => {
  it("numérote en continu (cabinet d'abord, puis web) - jamais deux listes qui redémarrent à 1", () => {
    const sources = construireSourcesDisponibles([cabinetMatch], [webResult]);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ index: 1, origine: "cabinet", reference: "Arrêt n° 12/2024" });
    expect(sources[1]).toMatchObject({ index: 2, origine: "web", reference: "CCJA, Arrêt n° 45/2023" });
  });
});

describe("formatSourcesPourPrompt", () => {
  it("inclut le numéro entre crochets et le contenu de chaque source", () => {
    const sources = construireSourcesDisponibles([cabinetMatch], [webResult]);
    const texte = formatSourcesPourPrompt(sources);
    expect(texte).toContain("[Source 1] Arrêt n° 12/2024");
    expect(texte).toContain("[Source 2] CCJA, Arrêt n° 45/2023");
    expect(texte).toContain("Texte de la décision...");
  });

  it("renvoie un message explicite quand aucune source n'est disponible", () => {
    expect(formatSourcesPourPrompt([])).toContain("Aucune source");
  });
});

describe("validerEtFiltrerCitations", () => {
  it("Test 1 - référence valide avec lien accessible : conservée, marqueur retiré, source dans sourcesValidees", async () => {
    const sources = construireSourcesDisponibles([cabinetMatch], []);
    const texteLlm = "La Cour Suprême a jugé que... (Arrêt n° 12/2024) [REF: Source 1]. Cela confirme la tendance.";

    const resultat = await validerEtFiltrerCitations(texteLlm, sources, accessible);

    expect(resultat.texte).not.toContain("[REF:");
    expect(resultat.texte).toContain("Cela confirme la tendance");
    expect(resultat.sourcesValidees).toEqual([
      {
        reference: "Arrêt n° 12/2024",
        juridiction: "Cour Suprême",
        date: "2024-03-15",
        lien: "https://coursupreme.bj/arret-12-2024",
        origine: "cabinet",
      },
    ]);
    expect(resultat.rejets).toHaveLength(0);
    expect(resultat.texte).not.toContain("⚠️");
  });

  it("Test 2 - référence hallucinée (numéro hors de la liste des sources) : retirée, signalée", async () => {
    const sources = construireSourcesDisponibles([cabinetMatch], []);
    const texteLlm = "Une décision fictive [REF: Source 7] appuie ce raisonnement.";

    const resultat = await validerEtFiltrerCitations(texteLlm, sources, accessible);

    expect(resultat.sourcesValidees).toHaveLength(0);
    expect(resultat.rejets).toEqual([{ reference: null, motif: "hallucination" }]);
    expect(resultat.texte).toContain("référence non vérifiée");
    expect(resultat.texte).toContain("Une partie de l'analyse n'a pas pu être sourcée");
  });

  it("Test 3 - référence valide mais lien mort : retirée, log distinct 'lien_inaccessible'", async () => {
    const sources = construireSourcesDisponibles([cabinetMatch], []);
    const texteLlm = "Décision pertinente [REF: Source 1].";

    const resultat = await validerEtFiltrerCitations(texteLlm, sources, inaccessible);

    expect(resultat.sourcesValidees).toHaveLength(0);
    expect(resultat.rejets).toEqual([{ reference: "Arrêt n° 12/2024", motif: "lien_inaccessible" }]);
  });

  it("Test 4 - chunk RAG sans champ lien : retirée, log distinct 'lien_manquant', jamais de requête HTTP inutile", async () => {
    const sources = construireSourcesDisponibles([cabinetMatchSansLien], []);
    const verifierLienFn = vi.fn(accessible);
    const texteLlm = "Décision ancienne [REF: Source 1].";

    const resultat = await validerEtFiltrerCitations(texteLlm, sources, verifierLienFn);

    expect(resultat.sourcesValidees).toHaveLength(0);
    expect(resultat.rejets).toEqual([{ reference: "Arrêt n° 99/2020", motif: "lien_manquant" }]);
    // Pas de verification HTTP pour une source qui n'a de toute facon pas de lien.
    expect(verifierLienFn).not.toHaveBeenCalled();
  });

  it("Test 5 - le lien affiché est toujours celui de la source, jamais une URL produite par le LLM", async () => {
    const sources = construireSourcesDisponibles([cabinetMatch], []);
    const texteLlm =
      "Voir la décision [REF: Source 1], consultable ici : https://site-suspect.test/faux-lien-invente-par-le-llm";

    const resultat = await validerEtFiltrerCitations(texteLlm, sources, accessible);

    expect(resultat.sourcesValidees[0].lien).toBe("https://coursupreme.bj/arret-12-2024");
    expect(resultat.texte).not.toContain("site-suspect.test");
    expect(resultat.texte).toContain("[lien retiré]");
  });

  it("Test 6 - aucune citation : le texte reste affiché normalement, pas de bloc Source, pas d'avertissement", async () => {
    const sources = construireSourcesDisponibles([cabinetMatch], []);
    const texteLlm = "Analyse générale du sujet, sans décision précise à citer pour l'instant.";

    const resultat = await validerEtFiltrerCitations(texteLlm, sources, accessible);

    expect(resultat.texte).toBe(texteLlm);
    expect(resultat.sourcesValidees).toHaveLength(0);
    expect(resultat.rejets).toHaveLength(0);
  });

  it("Test 7 - comportement identique quelle que soit la formulation du LLM (indépendant du provider)", async () => {
    const sources = construireSourcesDisponibles([cabinetMatch], []);
    // Deux formulations differentes (style "Anthropic" vs style "Groq"),
    // meme marqueur [REF: Source 1] - la detection est purement structurelle
    // (regex sur le marqueur), jamais dependante du style redactionnel d'un
    // fournisseur LLM en particulier.
    const texteAnthropicStyle = "Selon la jurisprudence constante [REF: Source 1], la solution est claire.";
    const texteGroqStyle = "La Cour a tranché en ce sens [REF: Source 1] dans un arrêt de principe.";

    const resultatA = await validerEtFiltrerCitations(texteAnthropicStyle, sources, accessible);
    const resultatB = await validerEtFiltrerCitations(texteGroqStyle, sources, accessible);

    expect(resultatA.sourcesValidees).toHaveLength(1);
    expect(resultatB.sourcesValidees).toHaveLength(1);
    expect(resultatA.sourcesValidees[0]).toEqual(resultatB.sourcesValidees[0]);
  });

  it("Test 8 - performance : les vérifications de liens sont parallélisées, pas séquentielles", async () => {
    const sources = construireSourcesDisponibles([cabinetMatch, { ...cabinetMatch, id: "c3", reference: "Arrêt n° 2" }], []);
    let enCours = 0;
    let maxParalleles = 0;
    const verifierLienFn = vi.fn(async () => {
      enCours++;
      maxParalleles = Math.max(maxParalleles, enCours);
      await new Promise((r) => setTimeout(r, 30));
      enCours--;
      return { accessible: true, statut: 200, verifieA: Date.now() };
    });
    const texteLlm = "Decision 1 [REF: Source 1]. Decision 2 [REF: Source 2].";

    const debut = Date.now();
    const resultat = await validerEtFiltrerCitations(texteLlm, sources, verifierLienFn);
    const duree = Date.now() - debut;

    expect(resultat.sourcesValidees).toHaveLength(2);
    expect(maxParalleles).toBe(2); // les deux verifications tournent en meme temps
    expect(duree).toBeLessThan(55); // largement < 2 x 30ms si ca avait ete sequentiel
  });

  it("ne vérifie chaque source citée qu'une seule fois, même citée plusieurs fois dans le texte", async () => {
    const sources = construireSourcesDisponibles([cabinetMatch], []);
    const verifierLienFn = vi.fn(accessible);
    const texteLlm = "D'abord [REF: Source 1], puis rappelé plus loin [REF: Source 1] dans le tableau.";

    await validerEtFiltrerCitations(texteLlm, sources, verifierLienFn);

    expect(verifierLienFn).toHaveBeenCalledTimes(1);
  });
});

// Type-only import guard - garantit que SourceDisponible reste exporte et
// utilisable par d'autres modules (ex: webActions.ts) sans erreur de build.
const _sourceExemple: SourceDisponible = {
  index: 1,
  origine: "cabinet",
  reference: "x",
  juridiction: null,
  date: null,
  lien: null,
  extrait: "",
  categorieWeb: null,
};
void _sourceExemple;
