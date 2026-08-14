import { z } from "zod";

// Qualites procedurales possibles pour une partie (client ou adverse) dans
// des conclusions - alignees sur celles utilisees pour le role de la
// semaine (memes intitules dans toute l'appli).
const QUALITE_PROCEDURALE = [
  "Demandeur",
  "Défendeur",
  "Intervenant volontaire",
  "Intervenant forcé",
  "Appelant",
  "Intimé",
  "Demandeur au pourvoi",
  "Défendeur au pourvoi",
] as const;

export const notesFormSchema = z.object({
  type_action: z.literal("notes"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1),
  date_audience: z.string().min(1),
  nom_juridiction: z.string().min(1),
  nom_chambre: z.string().optional(),
  nom_avocat: z.string().optional(),
  adresse_cabinet_manuel: z.string().optional(),
  ville: z.string().optional(),
  numero_rg: z.string().min(1),
  objet_litige: z.string().min(1),
  nom_juge: z.string().optional(),
  nom_greffier: z.string().optional(),
  nom_partie_adverse: z.string().optional(),
  rappel_procedure: z.string().optional(),
  deroulement_debats: z.string().min(1),
  decision: z.string().min(1),
  prochaine_audience: z.string().min(1),
  pieces_prevoir: z.array(z.string()).min(1),
  // Redige par l'avocat lui-meme (au besoin avec l'aide d'une proposition
  // IA relue et adaptee avant envoi) - jamais genere automatiquement dans
  // le compte-rendu final, car cette note part aussi au client.
  strategie_suite: z.string().optional(),
});

// Champs communs a plaidoirie / conclusions / assignation : meme logique
// (dossier + contexte + axes d'argumentation), seul le texte genere differe.
// nom_client est optionnel : necessaire seulement si le dossier n'existe pas
// encore (creation a la volee), ignore si le dossier existe deja.
const texteJuridiqueFields = {
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1).optional(),
  contexte: z.string().min(1),
  axes_argumentation: z.array(z.string().min(1)).min(1),
};

// Champs pour adresser la plaidoirie/conclusions a un destinataire precis
// (le juge, ou la partie adverse via son avocat) - toujours facultatifs,
// une plaidoirie/conclusions n'a pas forcement besoin d'etre "adressee".
const destinataireDocumentFields = {
  destinataire: z.string().optional(),
  nom_juridiction: z.string().optional(),
  ville: z.string().optional(),
  // Nom du confrere destinataire, utilise seulement si destinataire = "Maître".
  nom_avocat_destinataire: z.string().optional(),
};

export const redacFormSchema = z.object({
  type_action: z.literal("redac"),
  ...texteJuridiqueFields,
  // Contrairement a assignation/conclusions, une plaidoirie "rapide" peut
  // etre generee sans rattachement precis a un dossier numerote.
  numero_dossier: z.string().optional(),
  nom_affaire: z.string().optional(),
  // Pas de destinataireDocumentFields ici : la plaidoirie est le discours
  // que l'avocat prononce lui-meme a l'audience, jamais une lettre adressee
  // a quelqu'un d'autre (contrairement a la Note de plaidoirie, deposee au
  // dossier et formellement adressee au tribunal).
});

export const conclusionsFormSchema = z.object({
  type_action: z.literal("conclusions"),
  ...texteJuridiqueFields,
  numero_dossier: z.string().optional(),
  nom_affaire: z.string().optional(),
  ...destinataireDocumentFields,
  // I. Les parties.
  nom_avocat: z.string().optional(),
  // Adresse du cabinet : normalement deja renseignee dans Parametres, ce
  // champ n'est qu'un secours si elle n'y est pas encore.
  adresse_cabinet_manuel: z.string().optional(),
  qualite_client: z.enum(QUALITE_PROCEDURALE).optional(),
  // Infos civiles du client (naissance, adresse) : normalement deja
  // presentes sur sa fiche, ce champ n'est qu'un secours si elles n'y sont
  // pas encore.
  informations_client: z.string().optional(),
  // Nationalite du client/de la partie adverse (personne physique
  // uniquement, sans objet pour une personne morale - laisser vide).
  nationalite_client: z.string().optional(),
  nom_partie_adverse: z.string().optional(),
  informations_partie_adverse: z.string().optional(),
  qualite_partie_adverse: z.enum(QUALITE_PROCEDURALE).optional(),
  nationalite_partie_adverse: z.string().optional(),
  // 2. Discussion juridique - jamais devinee par l'IA si absente.
  fondement_juridique: z.string().optional(),
  qualification_juridique: z.string().optional(),
  prejudice_subi: z.string().optional(),
  reparation_demandee: z.string().optional(),
  montant_frais_procedure: z.coerce.number().positive().optional(),
  // III. Par ces motifs.
  manquement_a_faire_juger: z.string().optional(),
  demander_depens: z.boolean().optional(),
  // IV. Bordereau des pieces jointes.
  pieces: z.array(z.string().min(1)).optional(),
});

export const notePlaidoirieFormSchema = z.object({
  type_action: z.literal("note_plaidoirie"),
  ...texteJuridiqueFields,
  numero_dossier: z.string().optional(),
  nom_affaire: z.string().optional(),
  ...destinataireDocumentFields,
  // En-tete specifique (RG, chambre, date d'audience) - pas dans les Conclusions.
  numero_rg: z.string().optional(),
  nom_chambre: z.string().optional(),
  date_audience: z.string().optional(),
  // I. Les parties (memes principes que pour les Conclusions).
  nom_avocat: z.string().optional(),
  adresse_cabinet_manuel: z.string().optional(),
  qualite_client: z.enum(QUALITE_PROCEDURALE).optional(),
  profession_client: z.string().optional(),
  // Civilite du client (personne physique uniquement) - normalement deja
  // sur sa fiche, ce champ n'est qu'un secours si elle n'y est pas encore.
  civilite_client_manuel: z.enum(["M.", "Mme", "Mlle"]).optional(),
  informations_client: z.string().optional(),
  nom_partie_adverse: z.string().optional(),
  qualite_partie_adverse: z.enum(QUALITE_PROCEDURALE).optional(),
  profession_partie_adverse: z.string().optional(),
  informations_partie_adverse: z.string().optional(),
  // Nom de l'avocat adverse pour le bloc "CONTRE" - distinct de
  // nom_avocat_destinataire (qui sert a adresser le courrier).
  nom_avocat_partie_adverse: z.string().optional(),
  // 2. Discussion juridique - jamais devinee par l'IA si absente.
  fondement_juridique: z.string().optional(),
  qualification_juridique: z.string().optional(),
  prejudice_subi: z.string().optional(),
  // 3. Dispositif : demandes en texte libre (pas de verbes figes, un litige
  // de propriete et un litige de paiement n'ont pas les memes demandes).
  demandes: z.array(z.string().min(1)).optional(),
  demander_depens: z.boolean().optional(),
});

export const assignationFormSchema = z.object({
  type_action: z.literal("assignation"),
  ...texteJuridiqueFields,
  // Le defendeur assigne - distinct du client, sert d'adresse sur l'acte.
  destinataire: z.string().min(1),
  // Avocat en charge du dossier - affiche sur l'acte, jamais devine.
  nom_avocat: z.string().min(1),
  adresse_cabinet_manuel: z.string().optional(),
  // Huissier/commissaire de justice charge de la delivrance de l'acte.
  nom_huissier: z.string().min(1),
  // Juridiction saisie (ex: Tribunal de Premiere Instance) - jamais devinee.
  nom_juridiction: z.string().min(1),
  // Chambre au sein de la juridiction (ex: chambre civile) - pas toujours
  // connue au moment de la redaction.
  nom_chambre: z.string().optional(),
  // Ville de la juridiction saisie, combinee a nom_juridiction sur l'acte.
  ville: z.string().min(1),
  // Date d'audience - pas toujours connue au moment de la redaction (fixee
  // par le greffe), donc facultative.
  date_audience: z.string().optional(),
  // I. Les parties - memes principes que Conclusions/Note de plaidoirie :
  // jamais devine par l'IA si absent.
  profession_client: z.string().optional(),
  // Naissance du client uniquement (pas l'adresse, voir adresse_client_manuel
  // ci-dessous) - normalement deja sur sa fiche, ce champ n'est qu'un secours.
  informations_client: z.string().optional(),
  adresse_client_manuel: z.string().optional(),
  // Civilite du client (personne physique uniquement) - normalement deja
  // sur sa fiche, ce champ n'est qu'un secours si elle n'y est pas encore.
  civilite_client_manuel: z.enum(["M.", "Mme", "Mlle"]).optional(),
  // Nationalite du client (personne physique uniquement, sans objet pour
  // une personne morale - laisser vide dans ce cas).
  nationalite_client: z.string().optional(),
  // Objet synthetique de la demande ("...pour le voir condamner au ...").
  demande_client: z.string().optional(),
  // Discussion juridique - jamais devinee par l'IA si absente.
  fondement_juridique: z.string().optional(),
  qualification_juridique: z.string().optional(),
  prejudice_subi: z.string().optional(),
  // Demandes precises au tribunal ("En consequence") - jamais devinees par
  // l'IA, toujours saisies par l'avocat.
  demandes: z.array(z.string().min(1)).min(1),
  // Pieces versees aux debats (bordereau) - optionnel, peut etre complete plus tard.
  pieces: z.array(z.string().min(1)).optional(),
});

export const miseEnDemeureFormSchema = z.object({
  type_action: z.literal("mise_en_demeure"),
  numero_dossier: z.string().min(1),
  nom_affaire: z.string().min(1),
  nom_client: z.string().min(1).optional(),
  // Mode de notification de l'acte - jamais devine.
  mode_notification: z.enum(["huissier", "lrar"]).optional(),
  nom_avocat: z.string().optional(),
  adresse_cabinet_manuel: z.string().optional(),
  // Adresse du client - normalement deja sur sa fiche, ce champ n'est
  // qu'un secours si elle n'y est pas encore (meme principe que
  // l'Assignation).
  adresse_client_manuel: z.string().optional(),
  // Destinataire de la mise en demeure (personne physique visee) - distinct
  // du client, jamais devine.
  destinataire: z.string().min(1),
  // Civilite du destinataire (personne physique uniquement).
  civilite_destinataire: z.enum(["M.", "Mme", "Mlle"]).optional(),
  profession_destinataire: z.string().optional(),
  // Regroupe tout le reste (entreprise, adresse...) en texte libre - meme
  // principe que informations_client/informations_partie_adverse ailleurs
  // dans l'appli, pour eviter la multiplication de champs distincts.
  informations_destinataire: z.string().optional(),
  // Ligne d'objet libre (ex: "D'ACHEVER LES TRAVAUX SOUS HUIT (08) JOURS") -
  // sinon composee automatiquement a partir du delai.
  objet: z.string().optional(),
  contexte: z.string().min(1),
  // Faits precis, jamais devines par l'IA si absents.
  date_obligation: z.string().optional(),
  description_obligation: z.string().optional(),
  date_echeance_prevue: z.string().optional(),
  montant_engage: z.string().optional(),
  delai_jours: z.coerce.number().int().positive(),
  // Consequences juridiques encourues en cas d'inexecution - jamais
  // devinees par l'IA, toujours saisies par l'avocat (meme principe que les
  // demandes de l'Assignation).
  consequences: z.array(z.string().min(1)).min(1),
});

export const jurisprudenceFormSchema = z.object({
  type_action: z.literal("jurisprudence"),
  theme: z.string().min(1),
  juridictions: z.array(z.string()).optional(),
  // Si coché : inclut aussi la base de jurisprudence propre au cabinet en
  // plus de la recherche web (Bénin, zone OHADA, Afrique, France,
  // francophonie, reste du monde). Decoche par defaut, la recherche est
  // deja large sans elle.
  inclure_cabinet: z.boolean().optional(),
});

export const rechercheJuridiqueFormSchema = z.object({
  type_action: z.literal("recherche_juridique"),
  question: z.string().min(1),
});

export const resumePdfFormSchema = z.object({
  type_action: z.literal("resume_pdf"),
  // Data URL base64 "data:application/pdf;base64,...."
  pdfDataUrl: z.string().regex(/^data:application\/pdf;base64,/),
  // Nom d'origine du fichier - jamais utilise pour nommer le fichier
  // physique stocke (voir services/stockageDocuments.ts), uniquement une
  // metadonnee d'affichage/telechargement.
  pdfNomOriginal: z.string().optional(),
  contexte: z.string().optional(),
  // Passerelle resume PDF -> base de jurisprudence : si cochee, le PDF est
  // aussi stocke durablement et indexe dans JurisprudenceChunk (voir
  // routes/webActions.ts). Les champs jurisprudence_* ne sont valides que
  // dans ce cas - verifie manuellement dans la route (jamais via
  // .superRefine() ici, incompatible avec z.discriminatedUnion en dessous).
  ajouterJurisprudence: z.boolean().optional(),
  jurisprudenceReference: z.string().optional(),
  jurisprudenceJuridiction: z.string().optional(),
  jurisprudenceDateDecision: z.string().optional(),
});

export const traductionFormSchema = z.object({
  type_action: z.literal("traduction"),
  sens: z.enum(["fr_vers_en", "en_vers_fr"]),
  texte_source: z.string().optional(),
  // Data URL base64 d'un PDF ou d'un .docx, alternative au texte colle.
  documentDataUrl: z
    .string()
    .regex(
      /^data:(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document);base64,/
    )
    .optional(),
});

export const plainteFormSchema = z.object({
  type_action: z.literal("plainte"),
  numero_dossier: z.string().optional(),
  nom_affaire: z.string().optional(),
  nom_client: z.string().min(1).optional(),
  // Deux presentations tres differentes selon qui redige : l'avocat pour
  // son client (represente), ou le plaignant lui-meme (l'avocat n'a fait
  // qu'assister a la redaction, sans representation). Pilote le choix du
  // formalisme applique au document local (voir documentFormalisme.ts).
  mode_redaction: z.enum(["avocat", "plaignant"]),
  // Le plaignant (client) - infos civiles, memes principes que
  // l'Assignation (DB-first, secours manuel si absent de sa fiche).
  profession_client: z.string().optional(),
  civilite_client_manuel: z.enum(["M.", "Mme", "Mlle"]).optional(),
  informations_client: z.string().optional(),
  adresse_client_manuel: z.string().optional(),
  // Nationalite du plaignant/du mis en cause (personne physique uniquement,
  // sans objet pour une personne morale - laisser vide dans ce cas).
  nationalite_client: z.string().optional(),
  // Utilises seulement en mode "plaignant" (en-tete a ses propres
  // coordonnees) - sans effet en mode "avocat".
  telephone_client_manuel: z.string().optional(),
  email_client_manuel: z.string().optional(),
  // Personne visee par la plainte - distincte du destinataire du courrier.
  nom_defendeur: z.string().min(1),
  civilite_defendeur: z.enum(["M.", "Mme", "Mlle"]).optional(),
  profession_defendeur: z.string().optional(),
  adresse_defendeur: z.string().optional(),
  nationalite_defendeur: z.string().optional(),
  // Civilite/qualite du destinataire (ex: "M. le Procureur de la Republique
  // pres"), composee avec la juridiction et la ville par le backend pour
  // former l'adresse complete du courrier. Facultatif.
  destinataire: z.string().optional(),
  nom_juridiction: z.string().optional(),
  nom_chambre: z.string().optional(),
  // Ville de la juridiction saisie, utilisee dans l'adresse du courrier.
  ville: z.string().optional(),
  nom_avocat: z.string().optional(),
  adresse_cabinet_manuel: z.string().optional(),
  // Qualification penale precise - jamais devinee par l'IA.
  qualification_infraction: z.string().optional(),
  date_faits: z.string().optional(),
  description_accord: z.string().optional(),
  montant_engage: z.string().optional(),
  contexte: z.string().min(1),
  fondement_juridique: z.string().optional(),
  demandes: z.array(z.string().min(1)).min(1),
  preuves: z.array(z.string().min(1)).optional(),
});

export const contratFormSchema = z.object({
  type_action: z.literal("contrat"),
  numero_dossier: z.string().optional(),
  nom_affaire: z.string().optional(),
  nom_client: z.string().min(1).optional(),
  est_avenant: z.boolean().optional(),
  // Champs d'un contrat "normal" - non requis si avenant.
  type_contrat: z.string().optional(),
  adresse_cabinet_manuel: z.string().optional(),
  // Contexte/motifs de l'accord - nourrit le preambule ("Attendu que...").
  contexte: z.string().optional(),
  partie_1: z.string().optional(),
  // Personne physique (etat civil) ou morale (RCCM/IFU) - jamais devine.
  type_partie_1: z.enum(["physique", "morale"]).optional(),
  informations_partie_1: z.string().optional(),
  // Nationalite (personne physique uniquement, sans objet si type_partie
  // est "morale" - laisser vide dans ce cas).
  nationalite_partie_1: z.string().optional(),
  partie_2: z.string().optional(),
  type_partie_2: z.enum(["physique", "morale"]).optional(),
  informations_partie_2: z.string().optional(),
  nationalite_partie_2: z.string().optional(),
  objet: z.string().optional(),
  obligations: z.string().optional(),
  duree: z.string().optional(),
  conditions_renouvellement: z.string().optional(),
  // Montant en jeu, quelle que soit sa nature (loyer, salaire, prix de
  // vente, remuneration de prestation...) - jamais un champ au nom fige
  // qui n'aurait pas de sens pour tous les types de contrat.
  remuneration: z.string().optional(),
  modalites_paiement: z.string().optional(),
  date_effet: z.string().optional(),
  conditions_resiliation: z.string().optional(),
  juridiction_competente: z.string().optional(),
  // Clause standard (texte fixe, jamais redige par l'IA) inseree telle
  // quelle si cochee.
  clause_force_majeure: z.boolean().optional(),
  clauses_particulieres: z.array(z.string().min(1)).optional(),
  // Champs specifiques a un avenant.
  reference_contrat_initial: z.string().optional(),
  objet_avenant: z.string().optional(),
});

export const notificationDateFormSchema = z.object({
  type_action: z.literal("notification_date"),
  numero_dossier: z.string().optional(),
  nom_affaire: z.string().optional(),
  nom_client: z.string().min(1).optional(),
  // Mode de notification de l'acte - jamais devine.
  mode_notification: z.enum(["huissier", "lrar", "main_propre"]).optional(),
  nom_avocat: z.string().optional(),
  adresse_cabinet_manuel: z.string().optional(),
  // Le client (expediteur, represente par l'avocat) - memes principes que
  // partout ailleurs (DB-first, secours manuel si absent de sa fiche).
  civilite_client_manuel: z.enum(["M.", "Mme", "Mlle"]).optional(),
  informations_client: z.string().optional(),
  // Destinataire de la notification - distinct du client.
  destinataire: z.string().min(1),
  civilite_destinataire: z.enum(["M.", "Mme", "Mlle"]).optional(),
  adresse_destinataire: z.string().optional(),
  // Ce qui est notifie determine quels champs s'appliquent - jamais un
  // seul gabarit fige, une notification peut concerner une date, une
  // rupture de contrat, ou autre chose.
  type_notification: z.enum(["date", "rupture_contrat", "autre"]),
  // Ligne d'objet libre - sinon composee automatiquement selon le type.
  objet: z.string().optional(),
  // -- Notification de date --
  date_notifiee: z.string().optional(),
  lieu: z.string().optional(),
  nom_juridiction: z.string().optional(),
  // -- Notification de rupture de contrat --
  type_contrat_concerne: z.string().optional(),
  date_signature_contrat: z.string().optional(),
  article_resiliation: z.string().optional(),
  duree_preavis: z.string().optional(),
  // Rupture avec preavis, ou pour faute (sans preavis) - deux redactions
  // tres differentes, jamais devinees par l'IA.
  mode_rupture: z.enum(["avec_preavis", "pour_faute"]).optional(),
  date_fin_prevue: z.string().optional(),
  motif_faute: z.string().optional(),
  date_mise_en_demeure_prealable: z.string().optional(),
  instructions_cloture: z.string().optional(),
  // -- Autre notification --
  contexte: z.string().optional(),
  precisions: z.string().optional(),
});

export const requeteFormSchema = z.object({
  type_action: z.literal("requete"),
  numero_dossier: z.string().optional(),
  nom_affaire: z.string().optional(),
  nom_avocat: z.string().optional(),
  adresse_cabinet_manuel: z.string().optional(),
  // Le requerant (client) - memes principes que partout ailleurs (DB-first,
  // secours manuel si absent de sa fiche).
  nom_client: z.string().min(1).optional(),
  civilite_client_manuel: z.enum(["M.", "Mme", "Mlle"]).optional(),
  informations_client: z.string().optional(),
  // Nationalite du requerant/du requis (personne physique uniquement, sans
  // objet pour une personne morale - laisser vide dans ce cas).
  nationalite_client: z.string().optional(),
  // Uniquement si le requerant est une personne morale agissant par son
  // representant legal (ex: "son Directeur General, Monsieur X").
  representant_legal: z.string().optional(),
  qualite_representant: z.string().optional(),
  // Le requis (partie adverse) - optionnel : une requete n'a pas toujours
  // de partie adverse nommee (ex: designation d'expert, requete conjointe).
  nom_defendeur: z.string().optional(),
  civilite_defendeur: z.enum(["M.", "Mme", "Mlle"]).optional(),
  profession_defendeur: z.string().optional(),
  adresse_defendeur: z.string().optional(),
  nationalite_defendeur: z.string().optional(),
  // Civilite du destinataire, composee avec la juridiction et la ville par
  // le backend pour former l'adresse complete du courrier. Facultatif.
  destinataire: z.string().optional(),
  nom_juridiction: z.string().optional(),
  ville: z.string().optional(),
  objet: z.string().min(1),
  contexte: z.string().min(1),
  fondement_juridique: z.string().optional(),
  montant_engage: z.string().optional(),
  // Demandes precises a l'autorite ("PAR CES MOTIFS") - jamais devinees
  // par l'IA, toujours saisies par l'avocat.
  demandes: z.array(z.string().min(1)).min(1),
  // Pieces versees aux debats (bordereau) - optionnel.
  pieces: z.array(z.string().min(1)).optional(),
});

// Reprend exactement les memes noms de champs que la Requete (voir
// requeteFormSchema) : un projet d'ordonnance se redige a partir des memes
// donnees (requerant, requis, juridiction, faits, montant...) - ca permet de
// pre-remplir ce formulaire directement depuis les champs enregistres d'une
// Requete existante (bouton "Pre-remplir depuis la derniere Requete").
export const projetOrdonnanceFormSchema = z.object({
  type_action: z.literal("projet_ordonnance"),
  numero_dossier: z.string().optional(),
  nom_affaire: z.string().optional(),
  nom_avocat: z.string().optional(),
  adresse_cabinet_manuel: z.string().optional(),
  // Le requerant (client, creancier).
  nom_client: z.string().min(1).optional(),
  civilite_client_manuel: z.enum(["M.", "Mme", "Mlle"]).optional(),
  informations_client: z.string().optional(),
  // Nationalite du requerant/du requis (personne physique uniquement, sans
  // objet pour une personne morale - laisser vide dans ce cas).
  nationalite_client: z.string().optional(),
  representant_legal: z.string().optional(),
  qualite_representant: z.string().optional(),
  // Le requis (partie adverse, debiteur) - optionnel.
  nom_defendeur: z.string().optional(),
  civilite_defendeur: z.enum(["M.", "Mme", "Mlle"]).optional(),
  profession_defendeur: z.string().optional(),
  adresse_defendeur: z.string().optional(),
  nationalite_defendeur: z.string().optional(),
  // Juridiction/juge qui rend l'ordonnance (le meme que le destinataire de
  // la Requete d'origine).
  destinataire: z.string().optional(),
  nom_juridiction: z.string().optional(),
  ville: z.string().optional(),
  objet: z.string().min(1),
  // Date a laquelle la requete d'origine a ete deposee - figure dans le visa
  // "Vu la requete en date du..." de l'ordonnance, distincte de la date du
  // jour (date de l'ordonnance elle-meme).
  date_requete: z.string().optional(),
  contexte: z.string().min(1),
  fondement_juridique: z.string().optional(),
  montant_engage: z.string().optional(),
  // Delai d'opposition laisse au debiteur (jours) - 15 jours par defaut en
  // droit OHADA/beninois, mais jamais impose : toujours modifiable.
  delai_opposition_jours: z.coerce.number().int().positive().optional(),
  // Ce que l'ordonnance doit enjoindre - jamais devine par l'IA, toujours
  // saisi par l'avocat (meme principe que "demandes" dans la Requete).
  demandes: z.array(z.string().min(1)).min(1),
  pieces: z.array(z.string().min(1)).optional(),
});

export const webActionFormSchema = z.discriminatedUnion("type_action", [
  notesFormSchema,
  redacFormSchema,
  conclusionsFormSchema,
  notePlaidoirieFormSchema,
  assignationFormSchema,
  miseEnDemeureFormSchema,
  jurisprudenceFormSchema,
  rechercheJuridiqueFormSchema,
  resumePdfFormSchema,
  traductionFormSchema,
  plainteFormSchema,
  contratFormSchema,
  notificationDateFormSchema,
  requeteFormSchema,
  projetOrdonnanceFormSchema,
]);

export type WebActionForm = z.infer<typeof webActionFormSchema>;
