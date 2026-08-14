import { describe, it, expect } from "vitest";
import { chunkerTexte } from "../chunkerTexte";

describe("chunkerTexte", () => {
  it("renvoie un seul chunk pour un texte sous le seuil (comportement inchangé pour une décision courte)", () => {
    const texte = "Un texte de décision suffisamment court, bien en-deçà du seuil de découpage.";
    expect(chunkerTexte(texte)).toEqual([texte]);
  });

  it("découpe un texte long en plusieurs chunks", () => {
    const paragraphe = "Un paragraphe de décision juridique suffisamment long pour peser dans le découpage. ".repeat(15);
    const texteLong = Array.from({ length: 6 }, () => paragraphe.trim()).join("\n\n");

    const chunks = chunkerTexte(texteLong);

    expect(chunks.length).toBeGreaterThan(1);
  });

  it("aucun chunk ne dépasse la limite de sécurité (marge large sous les 2048 tokens du modèle)", () => {
    const paragraphe = "Un paragraphe de décision juridique suffisamment long pour peser dans le découpage. ".repeat(20);
    const texteLong = Array.from({ length: 10 }, () => paragraphe.trim()).join("\n\n");

    const chunks = chunkerTexte(texteLong);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1800);
    }
  });

  it("découpe même un unique paragraphe (sans saut de ligne) trop long", () => {
    const texteSansParagraphes = "Mot ".repeat(1000); // ~5000 caractères, aucun \n\n

    const chunks = chunkerTexte(texteSansParagraphes);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1800);
    }
  });

  it("préserve un chevauchement entre deux chunks consécutifs (une idée à la frontière reste retrouvable)", () => {
    const paragraphes = Array.from(
      { length: 20 },
      (_, i) =>
        `Paragraphe numéro ${i} avec un contenu suffisamment long pour peser dans le découpage en chunks de la décision, répété pour dépasser largement le seuil de chunking.`
    );
    const texteLong = paragraphes.join("\n\n");

    const chunks = chunkerTexte(texteLong);

    expect(chunks.length).toBeGreaterThan(1);
    // Le second chunk commence par la fin du premier (chevauchement de 150
    // caractères, voir CHEVAUCHEMENT_CARACTERES dans chunkerTexte.ts) - une
    // idee a cheval sur la frontiere reste donc entierement presente dans
    // au moins un chunk.
    const chevauchementAttendu = chunks[0].slice(-150);
    expect(chunks[1].startsWith(chevauchementAttendu)).toBe(true);
  });
});
