import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSearchResult } from "../../tavily";

const searchWebMock = vi.fn<
  (query: string, maxResults?: number, includeDomains?: string[], timeRange?: string) => Promise<WebSearchResult[]>
>();

vi.mock("../../tavily", () => ({
  searchWeb: (...args: [string, number?, string[]?, string?]) => searchWebMock(...args),
}));

function resultat(url: string): WebSearchResult {
  return { title: `Décision ${url}`, url, content: "Texte de la décision..." };
}

// domainesConfiance.ts lit JURISPRUDENCE_SEUIL_SOURCES_MINIMUM une seule
// fois, au chargement du module - vi.resetModules() avant chaque test pour
// qu'une valeur differente posee dans un test n'affecte jamais le suivant.
describe("rechercherJurisprudenceTavily (recherche Tavily par catégorie)", () => {
  const ancienSeuil = process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM;

  beforeEach(() => {
    searchWebMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    if (ancienSeuil === undefined) delete process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM;
    else process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM = ancienSeuil;
  });

  it("appelle un Tavily ciblé par catégorie (Bénin, OHADA, France, Afrique francophone), avec les bons domaines", async () => {
    process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM = "0";
    searchWebMock.mockResolvedValue([]);
    const { rechercherJurisprudenceTavily } = await import("../rechercheTavily");
    const {
      DOMAINES_CONFIANCE_BENIN,
      DOMAINES_CONFIANCE_OHADA,
      DOMAINES_CONFIANCE_FRANCE,
      DOMAINES_CONFIANCE_AFRIQUE_FRANCOPHONE,
    } = await import("../domainesConfiance");

    await rechercherJurisprudenceTavily("bail commercial");

    expect(searchWebMock).toHaveBeenCalledTimes(4);
    const domainesAppeles = searchWebMock.mock.calls.map((appel) => appel[2]);
    expect(domainesAppeles).toContainEqual(DOMAINES_CONFIANCE_BENIN);
    expect(domainesAppeles).toContainEqual(DOMAINES_CONFIANCE_OHADA);
    expect(domainesAppeles).toContainEqual(DOMAINES_CONFIANCE_FRANCE);
    expect(domainesAppeles).toContainEqual(DOMAINES_CONFIANCE_AFRIQUE_FRANCOPHONE);
  });

  it("associe chaque résultat à sa catégorie d'origine", async () => {
    process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM = "0";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines?.includes("coursupreme.bj")) return [resultat("https://coursupreme.bj/arret-1")];
      return [];
    });
    const { rechercherJurisprudenceTavily } = await import("../rechercheTavily");

    const resultats = await rechercherJurisprudenceTavily("divorce");

    expect(resultats).toHaveLength(1);
    expect(resultats[0]).toMatchObject({ categorie: "benin", url: "https://coursupreme.bj/arret-1" });
  });

  it("déduplique par URL une décision trouvée dans plusieurs catégories (ex: juricaf.org dans OHADA et Afrique francophone)", async () => {
    process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM = "0";
    const dupliquee = resultat("https://juricaf.org/arret-ccja-1");
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines?.includes("ohada.org")) return [dupliquee]; // categorie "ohada"
      if (domaines?.length === 2 && domaines.includes("ahjucaf.org")) return [dupliquee]; // categorie "afrique_francophone"
      return [];
    });
    const { rechercherJurisprudenceTavily } = await import("../rechercheTavily");

    const resultats = await rechercherJurisprudenceTavily("succession");

    expect(resultats.map((r) => r.url)).toEqual(["https://juricaf.org/arret-ccja-1"]);
    // La premiere categorie a l'avoir trouvee (ohada, avant afrique_francophone
    // dans l'ordre de CATEGORIES_DOMAINES_CONFIANCE) est celle conservee.
    expect(resultats[0].categorie).toBe("ohada");
  });

  it("une catégorie sans résultat ne bloque pas les autres", async () => {
    process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM = "0";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines?.includes("coursupreme.bj")) return []; // benin : aucun resultat
      if (domaines?.includes("legifrance.gouv.fr")) return [resultat("https://legifrance.gouv.fr/arret-1")];
      return [];
    });
    const { rechercherJurisprudenceTavily } = await import("../rechercheTavily");

    const resultats = await rechercherJurisprudenceTavily("clause pénale");

    expect(resultats).toHaveLength(1);
    expect(resultats[0].categorie).toBe("france");
  });

  it("ne déclenche PAS l'appel de secours ouvert quand la couverture ciblée dépasse le seuil", async () => {
    process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM = "2";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines?.includes("coursupreme.bj")) {
        return [resultat("https://coursupreme.bj/a"), resultat("https://coursupreme.bj/b")];
      }
      return [];
    });
    const { rechercherJurisprudenceTavily } = await import("../rechercheTavily");

    await rechercherJurisprudenceTavily("bail");

    // 4 appels cibles seulement, jamais de 5e appel sans include_domains.
    expect(searchWebMock).toHaveBeenCalledTimes(4);
    expect(searchWebMock.mock.calls.every((appel) => appel[2] !== undefined)).toBe(true);
  });

  it("déclenche l'appel de secours ouvert (sans include_domains) quand la couverture ciblée est sous le seuil", async () => {
    process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM = "3";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines === undefined) return [resultat("https://exemple.org/ouvert")]; // appel de secours
      return []; // aucun resultat cible
    });
    const { rechercherJurisprudenceTavily } = await import("../rechercheTavily");

    const resultats = await rechercherJurisprudenceTavily("garantie");

    expect(searchWebMock).toHaveBeenCalledTimes(5);
    const appelOuvert = searchWebMock.mock.calls.find((appel) => appel[2] === undefined);
    expect(appelOuvert).toBeDefined();
    expect(resultats).toHaveLength(1);
    expect(resultats[0].categorie).toBe("ouvert");
  });

  it("journalise le nombre de sources par catégorie", async () => {
    process.env.JURISPRUDENCE_SEUIL_SOURCES_MINIMUM = "0";
    searchWebMock.mockImplementation(async (_query, _max, domaines) => {
      if (domaines?.includes("coursupreme.bj")) return [resultat("https://coursupreme.bj/a")];
      return [];
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { rechercherJurisprudenceTavily } = await import("../rechercheTavily");

    await rechercherJurisprudenceTavily("bail");

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("benin=1"));
    logSpy.mockRestore();
  });
});
