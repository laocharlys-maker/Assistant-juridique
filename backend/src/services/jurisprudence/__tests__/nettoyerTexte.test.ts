import { describe, it, expect } from "vitest";
import { nettoyerTexte } from "../nettoyerTexte";

describe("nettoyerTexte", () => {
  it("recolle un mot/phrase coupé par un retour à la ligne en milieu de phrase", () => {
    const brut = "Le tribunal considère que la demande\nest recevable en la forme.";
    expect(nettoyerTexte(brut)).toBe("Le tribunal considère que la demande est recevable en la forme.");
  });

  it("ne recolle PAS deux lignes quand la première se termine par une ponctuation de fin de phrase", () => {
    const brut = "Le tribunal statue.\nEn conséquence, la demande est rejetée.";
    expect(nettoyerTexte(brut)).toBe("Le tribunal statue.\nEn conséquence, la demande est rejetée.");
  });

  it("ne recolle PAS deux lignes quand la seconde commence par une majuscule (nouvelle phrase probable)", () => {
    const brut = "Le tribunal en a délibéré\nEn conséquence, la demande est rejetée.";
    expect(nettoyerTexte(brut)).toBe("Le tribunal en a délibéré\nEn conséquence, la demande est rejetée.");
  });

  it("préserve les vrais sauts de paragraphe (ligne vide) entre deux blocs", () => {
    const brut = "Premier paragraphe complet.\n\nSecond paragraphe complet.";
    expect(nettoyerTexte(brut)).toBe("Premier paragraphe complet.\n\nSecond paragraphe complet.");
  });

  it("normalise les espaces multiples en un seul espace", () => {
    const brut = "Le    tribunal   statue.";
    expect(nettoyerTexte(brut)).toBe("Le tribunal statue.");
  });

  it("supprime les lignes courtes identiques répétées (en-tête/pied de page)", () => {
    const brut = [
      "Cour Suprême du Bénin — page 1",
      "Premier paragraphe de la décision.",
      "Cour Suprême du Bénin — page 1",
      "Second paragraphe de la décision.",
      "Cour Suprême du Bénin — page 1",
      "Troisième paragraphe de la décision.",
    ].join("\n\n");

    const resultat = nettoyerTexte(brut);
    expect(resultat).not.toContain("Cour Suprême du Bénin — page 1");
    expect(resultat).toContain("Premier paragraphe de la décision.");
    expect(resultat).toContain("Second paragraphe de la décision.");
    expect(resultat).toContain("Troisième paragraphe de la décision.");
  });

  it("ne supprime PAS une courte ligne qui n'apparaît qu'une ou deux fois (pas un en-tête répété)", () => {
    const brut = "Titre bref.\n\nPremier paragraphe.\n\nTitre bref.\n\nSecond paragraphe.";
    expect(nettoyerTexte(brut)).toContain("Titre bref.");
  });

  it("gère un texte déjà propre sans le déformer", () => {
    const brut = "Un texte déjà bien rédigé, sans artefact particulier.";
    expect(nettoyerTexte(brut)).toBe(brut);
  });
});
