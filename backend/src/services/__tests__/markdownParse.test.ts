import { describe, it, expect } from "vitest";
import { parseMarkdownBlocks } from "../markdownParse";

describe("parseMarkdownBlocks", () => {
  it("reconnait un paragraphe simple sans syntaxe markdown", () => {
    const blocks = parseMarkdownBlocks("Un texte tout simple.");
    expect(blocks).toEqual([
      { type: "paragraph", spans: [{ text: "Un texte tout simple.", bold: false }] },
    ]);
  });

  it("reconnait les titres de niveau 1 a 3", () => {
    const blocks = parseMarkdownBlocks("# Titre 1\n\n## Titre 2\n\n### Titre 3");
    expect(blocks).toEqual([
      { type: "heading", level: 1, spans: [{ text: "Titre 1", bold: false }] },
      { type: "heading", level: 2, spans: [{ text: "Titre 2", bold: false }] },
      { type: "heading", level: 3, spans: [{ text: "Titre 3", bold: false }] },
    ]);
  });

  it("decoupe le gras en spans distincts, sans laisser les ** dans le texte", () => {
    const blocks = parseMarkdownBlocks("Un texte avec **un mot en gras** au milieu.");
    expect(blocks).toEqual([
      {
        type: "paragraph",
        spans: [
          { text: "Un texte avec ", bold: false },
          { text: "un mot en gras", bold: true },
          { text: " au milieu.", bold: false },
        ],
      },
    ]);
  });

  it("regroupe les lignes a puces consecutives en un seul bloc", () => {
    const blocks = parseMarkdownBlocks("- Premier\n- Deuxieme\n- Troisieme");
    expect(blocks).toEqual([
      {
        type: "bullet",
        items: [
          [{ text: "Premier", bold: false }],
          [{ text: "Deuxieme", bold: false }],
          [{ text: "Troisieme", bold: false }],
        ],
      },
    ]);
  });

  it("regroupe les lignes numerotees consecutives en un seul bloc", () => {
    const blocks = parseMarkdownBlocks("1. Premier\n2. Deuxieme");
    expect(blocks).toEqual([
      {
        type: "numbered",
        items: [[{ text: "Premier", bold: false }], [{ text: "Deuxieme", bold: false }]],
      },
    ]);
  });

  it("interrompt une liste des qu'une ligne differente apparait", () => {
    const blocks = parseMarkdownBlocks("- Un\n- Deux\n\nUn paragraphe normal.");
    expect(blocks).toEqual([
      {
        type: "bullet",
        items: [[{ text: "Un", bold: false }], [{ text: "Deux", bold: false }]],
      },
      { type: "paragraph", spans: [{ text: "Un paragraphe normal.", bold: false }] },
    ]);
  });

  it("reconnait un tableau markdown et le separe du texte autour", () => {
    const markdown = [
      "Avant le tableau.",
      "",
      "| Critere | Valeur |",
      "| --- | --- |",
      "| A | 1 |",
      "| B | 2 |",
      "",
      "Apres le tableau.",
    ].join("\n");
    const blocks = parseMarkdownBlocks(markdown);
    expect(blocks).toEqual([
      { type: "paragraph", spans: [{ text: "Avant le tableau.", bold: false }] },
      {
        type: "table",
        header: ["Critere", "Valeur"],
        rows: [
          ["A", "1"],
          ["B", "2"],
        ],
      },
      { type: "paragraph", spans: [{ text: "Apres le tableau.", bold: false }] },
    ]);
  });

  it("ne confond pas une ligne de tableau isolee (sans separateur) avec un vrai tableau", () => {
    const blocks = parseMarkdownBlocks("Ceci n'est pas | un tableau");
    expect(blocks).toEqual([
      { type: "paragraph", spans: [{ text: "Ceci n'est pas | un tableau", bold: false }] },
    ]);
  });

  it("gere un texte vide", () => {
    expect(parseMarkdownBlocks("")).toEqual([]);
    expect(parseMarkdownBlocks("   \n\n  ")).toEqual([]);
  });
});
