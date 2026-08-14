import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSearchResult } from "../../tavily";

const searchWebMock = vi.fn<
  (query: string, maxResults?: number, includeDomains?: string[], timeRange?: string) => Promise<WebSearchResult[]>
>();

vi.mock("../../tavily", () => ({
  searchWeb: (...args: [string, number?, string[]?, string?]) => searchWebMock(...args),
}));

function resultat(url: string): WebSearchResult {
  return { title: `Texte ${url}`, url, content: "Extrait..." };
}

describe("rechercherJuridiqueTavily (recherche Tavily par catégorie - Recherche juridique)", () => {
  const ancienSeuil = process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM;

  beforeEach(() => {
    searchWebMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    if (ancienSeuil === undefined) delete process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM;
    else process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM = ancienSeuil;
  });

  it("appelle un Tavily ciblé par catégorie (Bénin, OHADA, doctrine/droit comparé, France), avec les domaines dédiés (distincts de la jurisprudence)", async () => {
    process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM = "0";
    searchWebMock.mockResolvedValue([]);
    const { rechercherJuridiqueTavily } = await import("../rechercheTavily");
    const { DOMAINES_BENIN, DOMAINES_OHADA, DOMAINES_DOCTRINE_DROIT_COMPARE, DOMAINES_FRANCE } = await import(
      "../domainesConfiance"
    );

    await rechercherJuridiqueTavily("création d'une SARL");

    expect(searchWebMock).toHaveBeenCalledTimes(4);
    const domainesAppeles = searchWebMock.mock.calls.map((appel) => appel[2]);
    expect(domainesAppeles).toContainEqual(DOMAINES_BENIN);
    expect(domainesAppeles).toContainEqual(DOMAINES_OHADA);
    expect(domainesAppeles).toContainEqual(DOMAINES_DOCTRINE_DROIT_COMPARE);
    expect(domainesAppeles).toContainEqual(DOMAINES_FRANCE);
    // Jamais les domaines de la jurisprudence (bases de decisions de justice).
    expect(domainesAppeles.flat()).not.toContain("juricaf.org");
    expect(domainesAppeles.flat()).not.toContain("coursupreme.bj");
  });

  it("une catégorie sans résultat ne bloque pas les autres", async () => {
    process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM = "0";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines?.includes("sgg.gouv.bj")) return []; // benin : aucun resultat
      if (domaines?.includes("legifrance.gouv.fr")) return [resultat("https://legifrance.gouv.fr/texte-1")];
      return [];
    });
    const { rechercherJuridiqueTavily } = await import("../rechercheTavily");

    const resultats = await rechercherJuridiqueTavily("bail commercial");

    expect(resultats).toHaveLength(1);
    expect(resultats[0].categorie).toBe("france");
  });

  it("ne déclenche PAS l'appel de secours ouvert quand la couverture ciblée dépasse le seuil", async () => {
    process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM = "2";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines?.includes("ohada.org")) return [resultat("https://ohada.org/a"), resultat("https://ohada.org/b")];
      return [];
    });
    const { rechercherJuridiqueTavily } = await import("../rechercheTavily");

    await rechercherJuridiqueTavily("société commerciale");

    expect(searchWebMock).toHaveBeenCalledTimes(4);
    expect(searchWebMock.mock.calls.every((appel) => appel[2] !== undefined)).toBe(true);
  });

  it("déclenche l'appel de secours ouvert (sans include_domains) quand la couverture ciblée est sous le seuil", async () => {
    process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM = "3";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines === undefined) return [resultat("https://exemple.org/ouvert")];
      return [];
    });
    const { rechercherJuridiqueTavily } = await import("../rechercheTavily");

    const resultats = await rechercherJuridiqueTavily("procédure de divorce");

    expect(searchWebMock).toHaveBeenCalledTimes(5);
    expect(resultats).toHaveLength(1);
    expect(resultats[0].categorie).toBe("ouvert");
  });

  it("journalise le nombre de sources par catégorie", async () => {
    process.env.RECHERCHE_JURIDIQUE_SEUIL_SOURCES_MINIMUM = "0";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines?.includes("ohada.org")) return [resultat("https://ohada.org/a")];
      return [];
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { rechercherJuridiqueTavily } = await import("../rechercheTavily");

    await rechercherJuridiqueTavily("société commerciale");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ohada=1"));
    logSpy.mockRestore();
  });
});
