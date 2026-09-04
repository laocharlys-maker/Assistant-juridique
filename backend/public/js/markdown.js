// Mini-moteur Markdown -> HTML, volontairement limite au sous-ensemble que
// les prompts d'Aurore produisent reellement (titres #/##/###, gras, listes
// a puces/numerotees, tableaux) : pas de dependance externe, tout le texte
// est echappe avant d'etre interprete (le contenu vient d'un LLM, jamais
// injecte tel quel en HTML).
(function () {
  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderInline(escapedText) {
    return escapedText
      // Liens Markdown ([texte](url)) - avant gras/italique car un titre de
      // source peut lui-meme contenir des * (peu probable mais sans risque
      // ainsi). escapeHtml() tourne toujours avant renderInline(), donc le
      // texte/url capture ici est deja HTML-safe (echappe), y compris pour
      // une insertion directe dans l'attribut href.
      .replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
      )
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  }

  // Marqueurs d'alignement (voir markdownParse.ts, moteur de rendu Word/PDF
  // reel, et la barre d'outils de l'editeur dans dossier.html) : reproduits
  // ici uniquement pour que l'apercu affiche le meme alignement, jamais
  // produits par l'IA elle-meme.
  function stripAlignMarker(line) {
    const center = line.match(/^\^\^\s?(.*)$/);
    if (center) return { text: center[1], align: "center" };
    const right = line.match(/^>\s?(.*)$/);
    if (right) return { text: right[1], align: "right" };
    const left = line.match(/^<\s?(.*)$/);
    if (left) return { text: left[1], align: "left" };
    return { text: line, align: null };
  }

  function isSeparatorRow(line) {
    return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(line.trim());
  }

  function parseTable(rawLines) {
    const rows = rawLines.map((l) =>
      l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())
    );
    const header = rows[0];
    const body = rows.slice(2);
    let html = '<table class="md-table"><thead><tr>';
    header.forEach((c) => (html += `<th>${renderInline(escapeHtml(c))}</th>`));
    html += "</tr></thead><tbody>";
    body.forEach((r) => {
      html += "<tr>";
      r.forEach((c) => (html += `<td>${renderInline(escapeHtml(c))}</td>`));
      html += "</tr>";
    });
    html += "</tbody></table>";
    return `<div class="md-table-wrap">${html}</div>`;
  }

  window.renderMarkdown = function (raw) {
    if (!raw) return "";
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    let html = "";
    let i = 0;
    let paragraphBuffer = [];

    function flushParagraph() {
      if (paragraphBuffer.length > 0) {
        html += `<p>${renderInline(escapeHtml(paragraphBuffer.join(" ")))}</p>`;
        paragraphBuffer = [];
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      if (line.trim() === "") {
        flushParagraph();
        i++;
        continue;
      }

      const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (headerMatch) {
        flushParagraph();
        const level = headerMatch[1].length + 2; // h3..h5 : reste sous les titres de la page
        html += `<h${level} class="md-heading">${renderInline(escapeHtml(headerMatch[2]))}</h${level}>`;
        i++;
        continue;
      }

      if (line.trim().startsWith("|") && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
        flushParagraph();
        const tableLines = [line];
        let j = i + 1;
        while (j < lines.length && lines[j].trim().startsWith("|")) {
          tableLines.push(lines[j]);
          j++;
        }
        html += parseTable(tableLines);
        i = j;
        continue;
      }

      const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
      if (bulletMatch) {
        flushParagraph();
        html += "<ul>";
        while (i < lines.length) {
          const m = lines[i].match(/^\s*[-*]\s+(.*)$/);
          if (!m) break;
          html += `<li>${renderInline(escapeHtml(m[1]))}</li>`;
          i++;
        }
        html += "</ul>";
        continue;
      }

      const numberedMatch = line.match(/^\s*\d+\.\s+(.*)$/);
      if (numberedMatch) {
        flushParagraph();
        html += "<ol>";
        while (i < lines.length) {
          const m = lines[i].match(/^\s*\d+\.\s+(.*)$/);
          if (!m) break;
          html += `<li>${renderInline(escapeHtml(m[1]))}</li>`;
          i++;
        }
        html += "</ol>";
        continue;
      }

      const aligned = stripAlignMarker(line);
      if (aligned.align) {
        flushParagraph();
        html += `<p style="text-align:${aligned.align};">${renderInline(escapeHtml(aligned.text.trim()))}</p>`;
        i++;
        continue;
      }

      paragraphBuffer.push(line.trim());
      i++;
    }
    flushParagraph();
    return html;
  };
})();
