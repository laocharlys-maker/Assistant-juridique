import { describe, it, expect } from "vitest";
import {
  splitSujets,
  periodeLabel,
  estPublicationRecente,
  filtrerResultatsRecents,
  formatSourcesVeillePourPrompt,
} from "../veilleJuridiqueUtils";
import type { WebSearchResult } from "../tavily";

describe("splitSujets", () => {
  it("separe les sujets par virgule", () => {
    expect(splitSujets("droit du travail, baux commerciaux, OHADA")).toEqual([
      "droit du travail",
      "baux commerciaux",
      "OHADA",
    ]);
  });

  it("separe les sujets par saut de ligne", () => {
    expect(splitSujets("droit du travail\nbaux commerciaux\n\nOHADA")).toEqual([
      "droit du travail",
      "baux commerciaux",
      "OHADA",
    ]);
  });

  it("ignore les entrees vides et les espaces superflus", () => {
    expect(splitSujets("  droit du travail ,, , OHADA  ")).toEqual(["droit du travail", "OHADA"]);
  });

  it("renvoie un tableau vide pour une chaine vide", () => {
    expect(splitSujets("")).toEqual([]);
  });
});

describe("periodeLabel", () => {
  it("couvre les 7 jours precedant la date donnee", () => {
    const now = new Date("2026-07-22T10:00:00Z");
    expect(periodeLabel(now)).toBe("mercredi 15 juillet 2026 au mercredi 22 juillet 2026");
  });
});

// La veille doit etre strictement limitee aux 7 derniers jours - jamais
// laisser le LLM deviner la fraicheur depuis le texte brut (voir
// veilleJuridiqueUtils.ts).
describe("estPublicationRecente", () => {
  const maintenant = new Date("2026-08-13T10:00:00Z");

  it("est recente si la date de publication tombe dans les 7 derniers jours", () => {
    expect(estPublicationRecente("2026-08-10", maintenant)).toBe(true);
    expect(estPublicationRecente("2026-08-06T10:00:00Z", maintenant)).toBe(true); // exactement J-7
  });

  it("n'est pas recente si la date de publication depasse les 7 derniers jours", () => {
    expect(estPublicationRecente("2026-08-05T09:00:00Z", maintenant)).toBe(false);
    expect(estPublicationRecente("2026-01-01", maintenant)).toBe(false);
  });

  it("n'est jamais recente si published_date est absent (jamais presume recent par defaut)", () => {
    expect(estPublicationRecente(undefined, maintenant)).toBe(false);
  });

  it("n'est jamais recente si published_date est imparsable", () => {
    expect(estPublicationRecente("pas une date", maintenant)).toBe(false);
  });
});

function resultat(url: string, publishedDate?: string): WebSearchResult {
  return { title: `Titre ${url}`, url, content: "Contenu de l'article...", publishedDate };
}

describe("filtrerResultatsRecents", () => {
  const maintenant = new Date("2026-08-13T10:00:00Z");

  it("retire les resultats sans date de publication ou hors periode, garde les autres", () => {
    const resultats = [
      resultat("https://exemple.bj/recent", "2026-08-12"),
      resultat("https://exemple.bj/sans-date"), // published_date absent
      resultat("https://exemple.bj/ancien", "2025-01-01"), // hors periode
    ];

    const { retenus, recus, apresFiltrage } = filtrerResultatsRecents(resultats, maintenant);

    expect(recus).toBe(3);
    expect(apresFiltrage).toBe(1);
    expect(retenus.map((r) => r.url)).toEqual(["https://exemple.bj/recent"]);
  });

  it("filtre independamment par appel (jamais melange entre themes)", () => {
    const themeA = [resultat("https://a.bj/1", "2026-08-12")];
    const themeB = [resultat("https://b.bj/1", "2020-01-01")];

    expect(filtrerResultatsRecents(themeA, maintenant).apresFiltrage).toBe(1);
    expect(filtrerResultatsRecents(themeB, maintenant).apresFiltrage).toBe(0);
  });
});

describe("formatSourcesVeillePourPrompt", () => {
  it("affiche la date de publication au format structure JJ-MM-AAAA, avec l'URL", () => {
    const texte = formatSourcesVeillePourPrompt([resultat("https://exemple.bj/a", "2026-08-12T15:30:00Z")]);
    expect(texte).toContain("[Source 1] — publié le 12-08-2026 — Titre https://exemple.bj/a — https://exemple.bj/a");
  });

  it("indique explicitement l'absence de resultat recent pour un theme (jamais un texte vide silencieux)", () => {
    expect(formatSourcesVeillePourPrompt([])).toBe("Aucun résultat récent (derniers 7 jours) disponible pour ce thème.");
  });
});
