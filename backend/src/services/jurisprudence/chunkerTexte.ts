/**
 * Decoupage en chunks du contenu (deja nettoye, voir nettoyerTexte.ts)
 * avant embedding dans la base de jurisprudence (routes/jurisprudenceBase.ts).
 *
 * Seuil choisi en fonction de la VRAIE limite du modele d'embedding utilise
 * (gemini-embedding-001) : 2048 tokens en entree, au-dela desquels le texte
 * est TRONQUE SILENCIEUSEMENT par defaut (autoTruncate, jamais desactive
 * dans ce projet - voir README-LOT18.md pour les sources). Une longue
 * decision entierement embeddee en un seul chunk risquait donc de perdre
 * silencieusement sa fin sans aucune erreur visible.
 *
 * TAILLE_CIBLE_CHUNK (1200 caracteres) reste tres en-deca de cette limite
 * meme avec une estimation pessimiste (~3 caracteres/token pour un texte
 * juridique francais accentue) : ~400 tokens par chunk, soit plus de 5x
 * de marge sous les 2048 tokens - jamais un objectif de "coller" a la
 * limite, une marge large est preferee (voir README-LOT18.md). Un chunk
 * plus petit ameliore aussi la precision de la recherche par similarite
 * (evite la dilution semantique d'un embedding calcule sur un texte trop
 * long et heterogene, cause identifiee dans l'audit).
 */

const SEUIL_CHUNKING_CARACTERES = 1500;
const TAILLE_CIBLE_CHUNK = 1200;
// Chevauchement entre deux chunks consecutifs : evite qu'une phrase/idee a
// cheval sur la frontiere de decoupage ne soit jamais presente en entier
// dans aucun chunk (donc jamais retrouvable par la recherche par similarite).
const CHEVAUCHEMENT_CARACTERES = 150;

export function chunkerTexte(texteNettoye: string): string[] {
  if (texteNettoye.length <= SEUIL_CHUNKING_CARACTERES) {
    return [texteNettoye];
  }

  const paragraphes = texteNettoye
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let courant = "";

  const clore = () => {
    if (courant.trim().length === 0) return;
    chunks.push(courant.trim());
    // Le chunk suivant reprend la fin du precedent (chevauchement), pour
    // ne jamais couper net une idee a la frontiere entre deux chunks.
    courant = courant.slice(-CHEVAUCHEMENT_CARACTERES);
  };

  for (const paragraphe of paragraphes) {
    if (courant.length > 0 && courant.length + paragraphe.length + 2 > TAILLE_CIBLE_CHUNK) {
      clore();
    }
    courant = courant ? `${courant}\n\n${paragraphe}` : paragraphe;

    // Un paragraphe a lui seul plus grand que la taille cible (rare pour
    // un texte juridique correctement mis en paragraphes, mais possible) :
    // decoupe brut par tranches, toujours avec chevauchement.
    while (courant.length > TAILLE_CIBLE_CHUNK * 1.5) {
      chunks.push(courant.slice(0, TAILLE_CIBLE_CHUNK).trim());
      courant = courant.slice(TAILLE_CIBLE_CHUNK - CHEVAUCHEMENT_CARACTERES);
    }
  }
  if (courant.trim().length > 0) chunks.push(courant.trim());

  return chunks;
}
