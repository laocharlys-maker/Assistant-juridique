// Libelle affiche pour chaque type de document - utilise a la fois pour les
// exports Word/PDF locaux et pour composer le nom du document genere
// (voir computeNomDocument ci-dessous).
export const TYPE_LABELS: Record<string, string> = {
  notes: "Compte-rendu d'audience",
  redac: "Plaidoirie",
  conclusions: "Conclusions",
  assignation: "Assignation",
  mise_en_demeure: "Mise en demeure",
  jurisprudence: "Recherche de jurisprudence",
  recherche_juridique: "Recherche juridique",
  resume_pdf: "Résumé de jurisprudence",
  veille_juridique: "Veille juridique",
  traduction: "Traduction",
  plainte: "Plainte",
  contrat: "Contrat",
  notification_date: "Notification",
  requete: "Requête",
  projet_ordonnance: "Projet d'ordonnance",
  note_plaidoirie: "Note de plaidoirie",
};

const COMBINING_DIACRITICS = new RegExp("[\\u0300-\\u036f]", "g");

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_DIACRITICS, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

// Nom "humain" du document genere (utilise comme titre du Google Doc cote
// n8n, et comme base du nom de fichier pour les exports Word/PDF locaux une
// fois passe par slugify) - distingue chaque document par les noms des
// parties plutot que par le seul type ("Assignation"), qui etait identique
// pour tous les documents d'un meme type.
export function computeNomDocument(facts: {
  typeAction: string;
  nomClient: string | null;
  nomAdverse?: string | null;
  numeroDossier?: string | null;
}): string {
  const client = facts.nomClient || "Client";
  if (facts.typeAction === "notes") {
    return `Compte-Rendu_${facts.numeroDossier || "SANS-NUMERO"}_${client}`;
  }
  const label = TYPE_LABELS[facts.typeAction] || facts.typeAction;
  if (facts.nomAdverse) {
    return `${label}_${client} contre ${facts.nomAdverse}`;
  }
  return `${label}_${client}`;
}
