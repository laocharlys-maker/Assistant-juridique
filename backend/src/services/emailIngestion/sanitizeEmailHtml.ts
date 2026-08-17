import sanitizeHtml from "sanitize-html";

/**
 * Nettoyage du HTML d'un email tiers avant affichage (bouton "Lire", voir
 * gmailClient.ts/imapClient.ts obtenirContenuComplet + routes/emailIngestion.ts).
 *
 * Le HTML source vient d'un expediteur non fiable (email quelconque, potentiel
 * phishing) : jamais insere tel quel dans l'appli. Deux couches de defense
 * independantes :
 *  1. Ce nettoyage supprime tout ce qui pourrait executer du code (script,
 *     gestionnaires d'evenements onXxx, iframe/object/embed/form, schemas
 *     dangereux type javascript:) et retire <style>/<link> (une feuille de
 *     style externe ou un bloc <style> avec des url() pourrait charger une
 *     image distante et contourner le blocage des images ci-dessous).
 *  2. Cote frontend (boite-reception.js), le HTML nettoye est affiche dans un
 *     <iframe sandbox="allow-same-origin"> SANS "allow-scripts" : meme si un
 *     script passait malgre tout cette etape, le navigateur refuserait de
 *     l'executer.
 *
 * Les images distantes sont bloquees par defaut (comme la plupart des clients
 * mail : une image est souvent un mouchard qui previent l'expediteur que le
 * mail a ete ouvert) - l'URL d'origine est deplacee vers l'attribut
 * data-blocked-src, le frontend ne la restaure dans src qu'a la demande
 * explicite de l'utilisateur ("Afficher les images").
 */
export function nettoyerHtmlEmail(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      "a",
      "b",
      "strong",
      "i",
      "em",
      "u",
      "s",
      "strike",
      "br",
      "p",
      "div",
      "span",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "td",
      "th",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "hr",
      "pre",
      "code",
      "font",
      "center",
      "img",
      "small",
      "sub",
      "sup",
    ],
    allowedAttributes: {
      a: ["href", "title", "target", "rel"],
      img: ["alt", "width", "height", "data-blocked-src"],
      font: ["color", "size", "face"],
      td: ["colspan", "rowspan", "align", "valign", "bgcolor", "width", "height"],
      th: ["colspan", "rowspan", "align", "valign", "bgcolor", "width", "height"],
      table: ["align", "bgcolor", "width", "height", "cellpadding", "cellspacing", "border"],
      "*": ["style", "align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    // Jamais de feuille de style externe/bloc <style> (voir commentaire
    // ci-dessus - contournement possible du blocage des images via CSS).
    nonTextTags: ["style", "script", "textarea", "option", "noscript"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
      img: (tagName, attribs) => {
        // "src" n'est volontairement pas dans allowedAttributes.img
        // ci-dessus : meme si on le renvoyait ici, sanitize-html le
        // retirerait quand meme apres coup - aucune image ne peut donc se
        // charger automatiquement, seul data-blocked-src porte l'URL
        // d'origine (restauree dans src a la demande, voir boite-reception.js).
        const attribsSansSrc = { ...attribs };
        delete attribsSansSrc.src;
        return { tagName: "img", attribs: { ...attribsSansSrc, "data-blocked-src": attribs.src || "" } };
      },
    },
  });
}
