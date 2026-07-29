// Parseur Markdown minimal, partagé par les exports Word et PDF
// (documentExport.ts) : couvre exactement le sous-ensemble de Markdown que
// les prompts d'Aurore produisent (titres #/##/###, gras **texte**, listes
// à puces/numérotées, tableaux), pour que ces documents ne montrent plus
// jamais la syntaxe Markdown brute.

export interface TextSpan {
  text: string;
  bold: boolean;
}

export type MarkdownBlock =
  | { type: "heading"; level: 1 | 2 | 3; spans: TextSpan[] }
  | { type: "paragraph"; spans: TextSpan[]; align?: "center" }
  | { type: "bullet"; items: TextSpan[][] }
  | { type: "numbered"; items: TextSpan[][] }
  | { type: "table"; header: string[]; rows: string[][] };

function parseInlineSpans(raw: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let cursor = 0;
  const re = /\*\*(.+?)\*\*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    if (match.index > cursor) {
      spans.push({ text: raw.slice(cursor, match.index), bold: false });
    }
    spans.push({ text: match[1], bold: true });
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

    // Marqueur de centrage ("^^texte") - reserve aux mises en forme
    // programmatiques (voir documentFormalisme.ts, ex. le bloc destinataire
    // d'une requete, ou la signature) : jamais produit par l'IA.
    const centerMatch = line.match(/^\^\^\s?(.*)$/);
    if (centerMatch) {
      blocks.push({ type: "paragraph", spans: parseInlineSpans(centerMatch[1]), align: "center" });
      i++;
      continue;
    }

    blocks.push({ type: "paragraph", spans: parseInlineSpans(line.trim()) });
    i++;
  }

  return blocks;
}
