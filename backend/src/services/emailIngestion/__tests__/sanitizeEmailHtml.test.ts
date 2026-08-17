import { describe, expect, it } from "vitest";
import { nettoyerHtmlEmail } from "../sanitizeEmailHtml";

describe("nettoyerHtmlEmail", () => {
  it("supprime les balises script et les gestionnaires d'evenements onXxx", () => {
    const sale = `<p onclick="alert(1)">Bonjour</p><script>alert(1)</script>`;
    const propre = nettoyerHtmlEmail(sale);

    expect(propre).not.toContain("<script");
    expect(propre).not.toContain("onclick");
    expect(propre).toContain("Bonjour");
  });

  it("bloque les schemas dangereux (javascript:) sur les liens", () => {
    const sale = `<a href="javascript:alert(1)">clique</a>`;
    const propre = nettoyerHtmlEmail(sale);

    expect(propre).not.toContain("javascript:");
  });

  it("conserve les liens http(s)/mailto normaux avec rel=noopener noreferrer", () => {
    const sale = `<a href="https://exemple.fr/page">lien</a>`;
    const propre = nettoyerHtmlEmail(sale);

    expect(propre).toContain('href="https://exemple.fr/page"');
    expect(propre).toContain("noopener");
    expect(propre).toContain("noreferrer");
  });

  it("deplace src des images vers data-blocked-src (images bloquees par defaut)", () => {
    const sale = `<img src="https://tracker.exemple.fr/pixel.gif" alt="photo">`;
    const propre = nettoyerHtmlEmail(sale);

    expect(propre).toContain('data-blocked-src="https://tracker.exemple.fr/pixel.gif"');
    // Aucun attribut "src" (le vrai, pas "data-blocked-src") ne doit
    // subsister - sinon l'image se chargerait automatiquement.
    expect(propre).not.toMatch(/(?<!-)src="/);
  });

  it("supprime les blocs <style> et <link> (contournement possible du blocage des images via CSS url())", () => {
    const sale = `<style>body{background:url(https://tracker.exemple.fr/pixel.gif)}</style><link rel="stylesheet" href="https://exemple.fr/style.css"><p>Texte</p>`;
    const propre = nettoyerHtmlEmail(sale);

    expect(propre).not.toContain("<style");
    expect(propre).not.toContain("<link");
    expect(propre).not.toContain("tracker.exemple.fr");
    expect(propre).toContain("Texte");
  });

  it("conserve la mise en page de base (paragraphes, gras, tableaux)", () => {
    const sale = `<table><tr><td><b>Important</b></td></tr></table><p>Paragraphe</p>`;
    const propre = nettoyerHtmlEmail(sale);

    expect(propre).toContain("<table>");
    expect(propre).toContain("<b>Important</b>");
    expect(propre).toContain("<p>Paragraphe</p>");
  });
});
