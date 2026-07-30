// Parseur Markdown minimal, partagé par les exports Word et PDF
// (documentExport.ts) : couvre exactement le sous-ensemble de Markdown que
// les prompts d'Aurore produisent (titres #/##/###, gras **texte**, listes
// à puces/numérotées, tableaux), pour que ces documents ne montrent plus
// jamais la syntaxe Markdown brute.

export interface TextSpan {
  text: string;
  bold: boolean;
  italic?: boolean;
}

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; spans: TextSpan[] }
  | {
      type: "paragraph";
      spans: TextSpan[];
      align?: "left" | "center" | "right";
      indent?: number;
      forcePlain?: boolean;
      titleSizePt?: number;
    }
  | { type: "bullet"; items: TextSpan[][] }
  | { type: "numbered"; items: TextSpan[][] }
  | { type: "table"; header: string[]; rows: string[][] };

// Gras ("**texte**") et italique ("*texte*" - un seul asterisque, meme
// convention que l'apercu cote client, js/markdown.js) : les deux styles
// peuvent apparaitre independamment dans un meme texte, jamais imbriques
// l'un dans l'autre. L'alternative "**" est testee en premier dans la regex
// pour ne jamais scinder un "**gras**" en italiques.
function parseInlineSpans(raw: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let cursor = 0;
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    if (match.index > cursor) {
      spans.push({ text: raw.slice(cursor, match.index), bold: false });
    }
    if (match[1] !== undefined) {
      spans.push({ text: match[1], bold: true });
    } else {
      spans.push({ text: match[2], bold: false, italic: true });
    }
    cursor = re.lastIndex;
  }
  if (cursor < raw.length) {
    spans.push({ text: raw.slice(cursor), bold: false });
  }
  return spans.length > 0 ? spans : [{ text: "", bold: false }];
}

function isSeparatorRow(line: string): boolean {
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim());
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.trim().startsWith("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      const header = parseTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith("|")) {
        rows.push(parseTableRow(lines[j]));
        j++;
      }
      blocks.push({ type: "table", header, rows });
      i = j;
      continue;
    }

    const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length as 1 | 2 | 3;
      blocks.push({ type: "heading", level, spans: parseInlineSpans(headerMatch[2]) });
      i++;
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (bulletMatch) {
      const items: TextSpan[][] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*]\s+(.*)$/);
        if (!m) break;
        items.push(parseInlineSpans(m[1]));
        i++;
      }
      blocks.push({ type: "bullet", items });
      continue;
    }

    const numberedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numberedMatch) {
      const items: TextSpan[][] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (!m) break;
        items.push(parseInlineSpans(m[1]));
        i++;
      }
      blocks.push({ type: "numbered", items });
      continue;
    }

    // Marqueur de titre centre en grande taille ("TITRE:N:texte", N en
    // points) - reserve au titre principal de certains formalismes (ex.
    // "NOTE DE PLAIDOIRIE") qui doit ressortir visuellement, plus grand que
    // le corps du texte.
    const titleMatch = line.match(/^TITRE:(\d+):\s?(.*)$/);
    if (titleMatch) {
      blocks.push({
        type: "paragraph",
        spans: parseInlineSpans(titleMatch[2]),
        align: "center",
        titleSizePt: Number(titleMatch[1]),
      });
      i++;
      continue;
    }

    // Marqueur de centrage ("^^texte") - reserve aux mises en forme
    // programmatiques (voir documentFormalisme.ts, ex. le bloc destinataire
    // d'une requete, ou la signature) : jamais produit par l'IA.
    const centerMatch = line.match(/^\^\^\s?(.*)$/);
    if (centerMatch) {
      blocks.push({ type: "paragraph", spans: parseInlineSpans(centerMatch[1]), align: "center" });
      i++;
      continue;
    }

    // Marqueur d'alignement a droite (">texte") - reserve aux mises en forme
    // programmatiques (ex. la ligne de date/lieu en tete d'un courrier).
    const rightMatch = line.match(/^>\s?(.*)$/);
    if (rightMatch) {
      blocks.push({ type: "paragraph", spans: parseInlineSpans(rightMatch[1]), align: "right" });
      i++;
      continue;
    }

    // Marqueur d'alignement a gauche ("<texte") - un paragraphe normal (sans
    // marqueur) est deja justifie par defaut (voir isHeaderLine plus bas) :
    // ce marqueur sert uniquement quand un alignement a gauche explicite est
    // demande (ex. depuis la barre d'outils de l'editeur).
    const leftMatch = line.match(/^<\s?(.*)$/);
    if (leftMatch) {
      blocks.push({ type: "paragraph", spans: parseInlineSpans(leftMatch[1]), align: "left" });
      i++;
      continue;
    }

    // Marqueur de retrait ("::N::texte", N en twips - 1440 = 1 pouce) -
    // reserve aux blocs de formalisme positionnes en retrait plutot que
    // centres (ex. bloc destinataire, bloc de signature) : reproduit
    // exactement la mise en forme observee dans les documents Google Docs
    // de reference plutot qu'un centrage approximatif.
    const indentMatch = line.match(/^::(\d+)::\s?(.*)$/);
    if (indentMatch) {
      blocks.push({ type: "paragraph", spans: parseInlineSpans(indentMatch[2]), indent: Number(indentMatch[1]) });
      i++;
      continue;
    }

    // Marqueur "texte impose" ("==texte") - force un rendu en paragraphe
    // normal meme si la ligne est TOUT EN MAJUSCULES (qui serait sinon
    // detectee comme un titre et mise en gras automatiquement, voir
    // isHeaderLine dans documentExport.ts) : reserve aux libelles de
    // formalisme qui doivent rester non gras (ex. "À LA REQUÊTE DE :").
    const plainMatch = line.match(/^==\s?(.*)$/);
    if (plainMatch) {
      blocks.push({ type: "paragraph", spans: parseInlineSpans(plainMatch[1]), forcePlain: true });
      i++;
      continue;
    }

    blocks.push({ type: "paragraph", spans: parseInlineSpans(line.trim()) });
    i++;
  }

  return blocks;
}
