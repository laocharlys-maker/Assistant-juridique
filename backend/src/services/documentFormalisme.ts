// Reconstruit, pour les exports Word/PDF generes localement (documentExport.ts),
// le formalisme juridique specifique a chaque type d'acte (identite des
// parties, huissier, greffier, juge, civilites, adresses...) qui, jusqu'ici,
// n'etait rempli que dans le template Google Docs via les balises
// (extraWebhookFields, voir routes/webActions.ts). Les valeurs utilisees ici
// sont exactement celles envoyees a n8n, persistees sur Action.champsDocument
// a la creation du document.
//
// Le texte produit est du "Markdown" au sens de markdownParse.ts (une ligne
// non vide = un paragraphe, **gras**, lignes TOUT EN MAJUSCULES mises en
// valeur automatiquement) - il est simplement concatene au texte redige par
// l'IA (input.contenu) avant d'etre passe au meme moteur de rendu Word/PDF,
// plutot que de dupliquer un chemin de rendu separe.

// Genre grammatical des juridictions beninoises pour accorder correctement
// "le/la {juridiction}" et "du/de la {juridiction}" - sans cette table, une
// Cour d'appel (feminin) recevrait a tort l'article masculin ("du Cour
// d'appel" au lieu de "de la Cour d'appel"). Meme table que
// JURIDICTIONS_BENIN_GENRE dans routes/webActions.ts (composeDestinataire).
const JURIDICTIONS_GENRE: Record<string, { article: string; possessif: string }> = {
  "Tribunal de Première Instance": { article: "le", possessif: "du" },
  "Tribunal de commerce": { article: "le", possessif: "du" },
  "Tribunal de Conciliation": { article: "le", possessif: "du" },
  "Cour d'appel": { article: "la", possessif: "de la" },
  "Cour de Répression des Infractions Économiques et du Terrorisme": { article: "la", possessif: "de la" },
  "Cour Suprême du Bénin": { article: "la", possessif: "de la" },
  "Cour Constitutionnelle du Bénin": { article: "la", possessif: "de la" },
  "Haute Cour de Justice": { article: "la", possessif: "de la" },
  "Cour de Cassation": { article: "la", possessif: "de la" },
};

function possessifJuridiction(nomJuridiction: string): string {
  return JURIDICTIONS_GENRE[nomJuridiction]?.possessif ?? "du";
}

function articleJuridiction(nomJuridiction: string): string {
  return JURIDICTIONS_GENRE[nomJuridiction]?.article ?? "le";
}

export interface FormalismeContext {
  nomClient: string;
  nomAffaire: string;
  numeroDossier: string;
  dateLongue: string;
  ville: string;
  dateAudienceLongue?: string;
  prochaineAudienceLongue?: string;
  piecesPrevoir?: string;
}

export interface Formalisme {
  // Remplace entierement le bloc générique "Cotonou, le... / Objet : ..."
  // habituellement ajoute par la mise en page (voir buildDocx/buildPdf).
  avant: string;
  apres?: string;
}

function s(champs: Record<string, unknown>, key: string): string {
  const v = champs[key];
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function ligne(...parts: (string | undefined | false)[]): string {
  return parts.filter((p): p is string => !!p && p.trim().length > 0).join(", ");
}

function bloc(...lignes: (string | undefined | false)[]): string {
  return lignes.filter((l): l is string => !!l && l.trim().length > 0).join("\n\n");
}

// Marque une ligne pour un rendu centre (voir le marqueur "^^" dans
// markdownParse.ts) - jamais utilise pour le texte redige par l'IA, reserve
// aux elements de formalisme (bloc destinataire, signature...).
function centre(texte: string | undefined | false): string | false {
  return texte ? `^^${texte}` : false;
}

// Titre principal centre, en grande taille (voir le marqueur "TITRE:N:"
// dans markdownParse.ts) - ex. "NOTE DE PLAIDOIRIE" en tete de document.
function titre(taillePt: number, texte: string | undefined | false): string | false {
  return texte ? `TITRE:${taillePt}:${texte}` : false;
}

// Un paragraphe visuellement vide (espace insecable) - pour forcer un
// espacement supplementaire entre deux lignes du formalisme sans que le
// parseur ne l'ignore (les lignes vides sont normalement sautees).
export function espace(): string {
  return "​";
}

// Empeche le gras automatique sur une ligne TOUT EN MAJUSCULES (voir le
// marqueur "==" dans markdownParse.ts) - certains libelles de formalisme
// (ex. "À LA REQUÊTE DE :") doivent rester en texte normal, a l'inverse
// d'autres libelles similaires qui sont, eux, en gras dans le document
// d'origine (ex. "DONNÉ ASSIGNATION À :").
function plein(texte: string | undefined | false): string | false {
  return texte ? `==${texte}` : false;
}

// Aligne une ligne a droite (voir le marqueur ">" dans markdownParse.ts) -
// ex. la ligne date/lieu en tete d'un courrier.
function droite(texte: string | undefined | false): string | false {
  return texte ? `>${texte}` : false;
}

// Retrait a gauche en twips (1440 = 1 pouce - voir le marqueur "::N::" dans
// markdownParse.ts) - reproduit le positionnement en retrait (plutot que
// centre) observe sur les blocs destinataire/signature des documents
// Google Docs de reference.
function retrait(twips: number, texte: string | undefined | false): string | false {
  return texte ? `::${twips}::${texte}` : false;
}

const UNITES = [
  "zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
  "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize",
  "dix-sept", "dix-huit", "dix-neuf",
];
const DIZAINES = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante-dix", "quatre-vingt", "quatre-vingt-dix"];

function deuxChiffresEnLettres(n: number): string {
  if (n < 20) return UNITES[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (d === 7 || d === 9) {
    if (u === 1 && d === 7) return `${DIZAINES[d]} et onze`;
    return `${DIZAINES[d]}-${UNITES[10 + u]}`;
  }
  if (u === 0) return d === 8 ? "quatre-vingts" : DIZAINES[d];
  if (u === 1 && d !== 8) return `${DIZAINES[d]} et un`;
  return `${DIZAINES[d]}-${UNITES[u]}`;
}

function centainesEnLettres(n: number): string {
  const c = Math.floor(n / 100);
  const reste = n % 100;
  const partCentaine = c === 0 ? "" : c === 1 ? "cent" : `${UNITES[c]} cent${reste === 0 ? "s" : ""}`;
  const partDizaine = reste === 0 ? "" : deuxChiffresEnLettres(reste);
  return [partCentaine, partDizaine].filter(Boolean).join(" ");
}

// Conversion d'une annee en toutes lettres ("2026" -> "deux mille vingt-six"),
// pour la formule notariee "L'AN DEUX MILLE VINGT-SIX" en tete d'assignation.
function anneeEnLettres(n: number): string {
  if (n === 0) return "zéro";
  const milliers = Math.floor(n / 1000);
  const reste = n % 1000;
  const partMillier = milliers === 0 ? "" : milliers === 1 ? "mille" : `${anneeEnLettres(milliers)} mille`;
  const partReste = reste === 0 ? "" : centainesEnLettres(reste);
  return [partMillier, partReste].filter(Boolean).join(" ");
}

export function buildFormalisme(
  typeAction: string,
  champsDocument: unknown,
  ctx: FormalismeContext
): Formalisme | null {
  const c = (champsDocument && typeof champsDocument === "object" ? champsDocument : {}) as Record<
    string,
    unknown
  >;

  // Aucune donnee composee disponible (document cree avant l'ajout de
  // champsDocument, ou type sans champs saisis) : on ne construit pas un
  // formalisme a moitie vide (virgules orphelines, lignes creuses) - on
  // revient a l'affichage generique existant (voir buildDocx/buildPdf).
  if (Object.keys(c).length === 0) return null;

  switch (typeAction) {
    case "notes": {
      // Reproduit le formalisme observe sur un document reel issu du
      // pipeline Google Docs (comparaison XML fournie par l'utilisateur) :
      // titre centre, toutes les lignes du bloc meta en gras (y compris
      // celles dont la valeur n'est pas TOUT EN MAJUSCULES - ex. noms
      // propres - qui echapperaient sinon a la detection automatique), et
      // le "Fait a..."/nom de l'avocat en retrait plutot qu'aligne a gauche.
      const juridiction = ligne(s(c, "nom_juridiction"), s(c, "nom_chambre"));
      return {
        avant: bloc(
          centre("**COMPTE RENDU D'AUDIENCE**"),
          ctx.dateAudienceLongue && `**DATE DE L'AUDIENCE : ${ctx.dateAudienceLongue}**`,
          juridiction && `**JURIDICTION : ${juridiction}**`,
          s(c, "nom_juge") && `**PRÉSIDENT DE CHAMBRE : ${s(c, "nom_juge")}**`,
          s(c, "nom_greffier") && `**GREFFIER : ${s(c, "nom_greffier")}**`,
          `**AFFAIRE : ${ctx.nomAffaire}**`,
          `**RÉFÉRENCE DOSSIER : ${ligne(ctx.numeroDossier, s(c, "numero_rg") && `RG n° ${s(c, "numero_rg")}`)}**`,
          s(c, "objet_litige") && `**OBJET DU LITIGE : ${s(c, "objet_litige")}**`
        ),
        apres: bloc(
          ctx.prochaineAudienceLongue && `**Prochaine date d'audience : ${ctx.prochaineAudienceLongue}**`,
          ctx.piecesPrevoir && `**Pièces à prévoir : ${ctx.piecesPrevoir}**`,
          retrait(5760, `Fait à ${ctx.ville}, le ${ctx.dateLongue}.`),
          s(c, "nom_avocat") && retrait(5760, s(c, "nom_avocat"))
        ),
      };
    }

    case "assignation": {
      // Reproduit exactement le formalisme observe sur des documents reels
      // issus du pipeline Google Docs (comparaison directe fournie par
      // l'utilisateur) : les valeurs injectees (noms, adresses) sont en
      // gras, la formule notariee d'ouverture et le rappel legal du
      // defendeur aussi, mais "À LA REQUÊTE DE :" reste en texte normal.
      const nomClient = s(c, "civilite_nom_client") || ctx.nomClient;
      const identiteClient = bloc(
        `**${nomClient}**${s(c, "profession_client") ? `, ${s(c, "profession_client")}` : ""}${
          s(c, "informations_client") ? `, ${s(c, "informations_client")}` : ""
        }${s(c, "adresse_client") ? `, demeurant à **${s(c, "adresse_client")}**` : ""}, élisant domicile au cabinet de son conseil, **${
          s(c, "nom_avocat") || ""
        }**, Avocat au Barreau du Bénin${s(c, "adresse_cabinet") ? `, y demeurant à **${s(c, "adresse_cabinet")}**` : ""},`
      );
      const juridictionPhrase =
        s(c, "nom_chambre") ||
        (s(c, "nom_juridiction") && `${articleJuridiction(s(c, "nom_juridiction"))} ${s(c, "nom_juridiction")}`);
      const annee = anneeEnLettres(new Date().getFullYear()).toUpperCase();
      return {
        avant: bloc(
          centre("**ASSIGNATION**"),
          `**L'AN ${annee}, et le ${ctx.dateLongue},**`,
          plein("À LA REQUÊTE DE :"),
          identiteClient,
          s(c, "nom_huissier") &&
            `**J'AI, ${s(c, "nom_huissier")}, COMMISSAIRE DE JUSTICE près le ${
              s(c, "nom_juridiction") || "Tribunal"
            } de ${ctx.ville}${
              s(c, "adresse_cabinet") ? `, y demeurant et domicilié à ${s(c, "adresse_cabinet")}` : ""
            } SOUSSIGNÉ :**`,
          s(c, "nom_defendeur") && "**DONNÉ ASSIGNATION À :**",
          s(c, "nom_defendeur") &&
            `**${s(c, "nom_defendeur")}**${s(c, "adresse_defendeur") ? `, demeurant à **${s(c, "adresse_defendeur")}**` : ""}`,
          s(c, "nom_defendeur") && "**OÙ ÉTANT ET PARLANT À :**",
          s(c, "nom_defendeur") &&
            Array.from({ length: 6 }, () => "………………………………………………………………………………………………………").join("\n\n"),
          juridictionPhrase &&
            `De comparaître par-devant Monsieur le Président et les Juges composant **${juridictionPhrase}** de **${ctx.ville}**, siégeant en l'une des salles ordinaires des audiences dudit Tribunal.`,
          "**TRÈS IMPORTANT — AVERTISSEMENT AU DÉFENDEUR :**",
          "Conformément à la loi, vous êtes tenu de constituer un avocat dans un délai de 15 jours à compter de la date du présent acte pour vous représenter. À défaut, un jugement pourra être rendu contre vous sur les seuls éléments fournis par votre adversaire."
        ),
        apres: bloc(plein("SOUS TOUTES RÉSERVES"), `Fait à ${ctx.ville}, le ${ctx.dateLongue}`),
      };
    }

    case "mise_en_demeure": {
      // Reproduit le formalisme observe sur un document reel issu du
      // pipeline Google Docs (comparaison XML fournie par l'utilisateur) :
      // en-tete cabinet en gras, date alignee a droite, bloc destinataire en
      // gras et en retrait (pas centre), signature de fin egalement en
      // retrait.
      const ligneDestinataire = s(c, "civilite_appel_destinataire")
        ? `${s(c, "civilite_appel_destinataire")} ${s(c, "destinataire")},`
        : `${s(c, "civilite_nom_destinataire") || s(c, "destinataire")},`;
      return {
        avant: bloc(
          s(c, "nom_cabinet") && `**${s(c, "nom_cabinet")}**`,
          s(c, "adresse_cabinet") && `**${s(c, "adresse_cabinet")}**`,
          "**Barreau du Bénin**",
          droite(`${ctx.ville}, le ${ctx.dateLongue}`),
          s(c, "mode_notification"),
          retrait(4320, "**À l'attention de :**"),
          retrait(4320, `**${ligneDestinataire}**`),
          s(c, "profession_destinataire") && retrait(4320, `**${s(c, "profession_destinataire")}**`),
          s(c, "informations_destinataire") && retrait(4320, `**${s(c, "informations_destinataire")}**`),
          s(c, "objet_mise_en_demeure") && `OBJET : ${s(c, "objet_mise_en_demeure")}`,
          s(c, "civilite_appel_destinataire"),
          `J'agis par la présente en qualité de conseil de ${ctx.nomClient}${
            s(c, "adresse_client") ? `, demeurant à ${s(c, "adresse_client")}` : ""
          }, qui m'a confié la défense de ses intérêts.`
        ),
        apres: bloc(
          "Sous toutes réserves dont mon client entend se prévaloir en justice.",
          `Veuillez agréer, ${s(c, "civilite_appel_destinataire") || "Madame, Monsieur,"} l'expression de mes salutations distinguées.`,
          s(c, "nom_avocat") && retrait(5040, `**Maître ${s(c, "nom_avocat")}**`),
          retrait(5040, "**Avocat au Barreau du Bénin**")
        ),
      };
    }

    case "plainte": {
      const civileTxt = s(c, "mode_redaction").includes("civile")
        ? "avec constitution de partie civile"
        : "";
      const nomClientPlainte = s(c, "civilite_nom_client") || ctx.nomClient;
      const nomDefendeurPlainte = s(c, "civilite_nom_defendeur") || s(c, "nom_defendeur");

      // Deux presentations tres differentes selon qui redige (voir le champ
      // mode_redaction dans schemas/webForms.ts) : l'avocat pour son client
      // represente (formalisme verifie sur "Plainte_CORRECTES.docx" -
      // en-tete cabinet, blocs POUR/CONTRE avec Maitre, QUALIFICATION DES
      // FAITS separee), ou le plaignant lui-meme, sans representation
      // (formalisme verifie sur "Plainte_Individ.docx" - pas d'en-tete
      // cabinet, identite du plaignant en guise d'expediteur, "LES FAITS :"
      // / "FONDEMENTS :", demandes en liste a puces avec le verbe en gras).
      if (s(c, "mode_redaction") === "plaignant") {
        return {
          avant: bloc(
            droite(`${ctx.ville}, le ${ctx.dateLongue}`),
            `**${nomClientPlainte}**`,
            s(c, "profession_client") && `**${s(c, "profession_client")}**`,
            s(c, "adresse_client") && `**Demeurant à : ${s(c, "adresse_client")}**`,
            plein("À"),
            s(c, "destinataire") && `**${s(c, "destinataire")}**`,
            // Pas d'espace apres "OBJET :" - reproduit tel quel le
            // formalisme observe sur le document de reference.
            `**OBJET :Plainte${civileTxt ? ` ${civileTxt} ` : " "}pour des faits de ${
              s(c, "qualification_infraction") || "..."
            }**`,
            "Monsieur le Procureur de la République,",
            `J'ai l'honneur de porter plainte entre vos mains contre le nommé **${nomDefendeurPlainte}**${
              s(c, "adresse_defendeur") ? `, demeurant à **${s(c, "adresse_defendeur")}**` : ""
            }, pour des faits de ${
              s(c, "qualification_infraction") || "..."
            } prévus et réprimés par le Code pénal en vigueur en République du Bénin.`
          ),
          apres: bloc(
            "Je me tiens à la disposition de vos services de police ou de gendarmerie pour toute audition ou confrontation nécessaire à la manifestation de la vérité.",
            "Je vous prie d'agréer, Monsieur le Procureur de la République, l'assurance de ma très haute considération.",
            retrait(5760, `**${nomClientPlainte}**`),
            centre("[Signature]")
          ),
        };
      }

      // Mode "avocat" - reproduit le formalisme observe sur un document reel
      // issu du pipeline Google Docs (comparaison XML fournie par
      // l'utilisateur) : en-tete cabinet en gras, date alignee a droite,
      // blocs POUR/CONTRE avec seuls les noms/adresses en gras (pas le
      // texte de liaison), "QUALIFICATION DES FAITS" en ligne separee (pas
      // ajoutee a l'objet), et la signature de fin en retrait.
      const contactClient = ligne(
        s(c, "informations_client"),
        s(c, "telephone_client") && `Téléphone ${s(c, "telephone_client")}`,
        s(c, "email_client")
      );
      return {
        avant: bloc(
          droite(`${ctx.ville}, le ${ctx.dateLongue}`),
          s(c, "nom_cabinet") && `**${s(c, "nom_cabinet")}**`,
          s(c, "adresse_cabinet") && `**${s(c, "adresse_cabinet")}**`,
          "**Barreau du Bénin**",
          centre("À"),
          s(c, "destinataire") && centre(`**${s(c, "destinataire")}**`),
          `**OBJET : Plainte${civileTxt ? ` ${civileTxt}` : ""}**`,
          `POUR **${nomClientPlainte}**${s(c, "profession_client") ? `, ${s(c, "profession_client")}` : ""}${
            s(c, "adresse_client") ? `, demeurant et domicilié à ${s(c, "adresse_client")}.` : "."
          }${contactClient ? ` ${contactClient}` : ""}`,
          s(c, "nom_avocat") &&
            `Ayant pour conseil **Maître ${s(c, "nom_avocat")}**, Avocat au Barreau du Bénin${
              s(c, "adresse_cabinet")
                ? `, dont le cabinet est situé à l'adresse **${s(c, "adresse_cabinet")}**, chez qui élection de domicile est faite pour les besoins de la présente procédure.`
                : "."
            }`,
          nomDefendeurPlainte &&
            `CONTRE : **${nomDefendeurPlainte}**${s(c, "profession_defendeur") ? `, ${s(c, "profession_defendeur")}` : ""}${
              s(c, "adresse_defendeur") ? `, demeurant à ${s(c, "adresse_defendeur")}.` : "."
            }`,
          s(c, "qualification_infraction") && `**QUALIFICATION DES FAITS : ${s(c, "qualification_infraction")}**`,
          "Monsieur le Procureur de la République,",
          `J'ai l'honneur d'intervenir par la présente en qualité de conseil de ${nomClientPlainte}, pour porter plainte entre vos mains contre ${nomDefendeurPlainte} pour les faits ci-dessus qualifiés.`
        ),
        apres: bloc(
          "Sous toutes réserves que de droit.",
          "Veuillez agréer, Monsieur le Procureur de la République, l'expression de ma très haute considération.",
          s(c, "nom_avocat") && retrait(5760, `**Maître ${s(c, "nom_avocat")}**`),
          retrait(5760, "**Avocat au Barreau du Bénin**"),
          retrait(5760, "(Sceau du Cabinet)")
        ),
      };
    }

    case "requete": {
      const qualiteClient = s(c, "qualite_representant")
        ? `, agissant en qualité de ${s(c, "qualite_representant")}`
        : "";
      const conseil = s(c, "nom_avocat")
        ? `Ayant pour Conseil Maître ${s(c, "nom_avocat")}, Avocat au Barreau du Bénin${
            s(c, "adresse_cabinet")
              ? `, y demeurant élisant domicile en son cabinet sis ${s(c, "adresse_cabinet")}.`
              : "."
          }`
        : "";
      const defendeur = ligne(
        s(c, "civilite_nom_defendeur") || s(c, "nom_defendeur"),
        s(c, "profession_defendeur")
      );
      return {
        avant: bloc(
          `Fait à ${ctx.ville}, le ${ctx.dateLongue}`,
          s(c, "nom_cabinet"),
          s(c, "adresse_cabinet"),
          centre("A"),
          centre(s(c, "destinataire")),
          s(c, "objet") && `**OBJET : ${s(c, "objet")}**`,
          "REQUÊTE",
          "POUR :",
          `${s(c, "civilite_nom_client") || ctx.nomClient}${qualiteClient}`,
          s(c, "informations_client"),
          conseil,
          defendeur && "CONTRE :",
          defendeur,
          s(c, "adresse_defendeur") && `Demeurant ${s(c, "adresse_defendeur")}`,
          `À ${s(c, "civilite_appel_destinataire") || "Madame, Monsieur,"}`
        ),
        apres: bloc(
          "Sous toutes réserves généralement quelconques.",
          centre(s(c, "nom_avocat") && `Maître ${s(c, "nom_avocat")}`),
          centre("Avocat au Barreau du Bénin"),
          s(c, "piece_a_prevoir") && `BORDEREAU DES PIÈCES COMMUNIQUÉES\n\n${s(c, "piece_a_prevoir")}`
        ),
      };
    }

    case "projet_ordonnance": {
      // Reproduit le formalisme observe sur un document reel issu du
      // pipeline Google Docs (comparaison XML fournie par l'utilisateur) :
      // ce n'est pas une simple lettre mais une veritable ordonnance de
      // justice (en-tete Republique du Benin, formule "Nous, ... Vu ...
      // Attendu que ... PAR CES MOTIFS ORDONNONS/DISONS/AVISONS"). Les
      // brackets non remplis observes dans le document de reference
      // ("[Prénom et NOM du Juge]", "[Numéro séquentiel]"...) sont des
      // artefacts de balises vides cote Google Docs, jamais reproduits ici
      // (voir la meme regle deja appliquee a la Plainte).
      const jurdictionVille = s(c, "nom_juridiction") && `${s(c, "nom_juridiction")} de ${ctx.ville}`;
      return {
        avant: bloc(
          "**RÉPUBLIQUE DU BÉNIN**",
          "**Fraternité – Justice – Travail**",
          "**MINISTÈRE DE LA JUSTICE ET DE LA LÉGISLATION**",
          jurdictionVille && `**${jurdictionVille}**`,
          `**DOSSIER N° : ${ctx.numeroDossier}**`,
          "**Ordonnance portant injonction de payer**",
          `Nous, ${
            s(c, "nom_juridiction")
              ? `**M. le Président ${possessifJuridiction(s(c, "nom_juridiction"))} ${s(c, "nom_juridiction")} de ${ctx.ville}**`
              : "M. le Président du Tribunal"
          }, assisté du Greffier en chef de ladite juridiction ;`,
          `Vu la requête${s(c, "date_requete") ? ` en date du ${s(c, "date_requete")}` : ""} à nous présentée par **${
            s(c, "civilite_nom_client") || ctx.nomClient
          }**${s(c, "informations_client") ? `, ${s(c, "informations_client")}` : ""}${
            s(c, "representant_legal")
              ? `, **${s(c, "representant_legal")}**, agissant en qualité de **${s(c, "qualite_representant") || "représentant légal"}**`
              : ""
          }${s(c, "nom_avocat") ? `, assistée de son conseil, **Maître ${s(c, "nom_avocat")}**, Avocat au Barreau du Bénin` : ""} ;`,
          "Vu les pièces jointes à l'appui de ladite requête ;"
        ),
        apres: bloc(
          `Fait en notre Cabinet, au Palais de Justice de ${ctx.ville}, le ${ctx.dateLongue}.`,
          "(Sceau du Tribunal)",
          "Le Greffier en chef",
          s(c, "nom_juridiction") &&
            `M. le Président ${possessifJuridiction(s(c, "nom_juridiction"))} ${s(c, "nom_juridiction")} de ${ctx.ville}`,
          s(c, "piece_a_prevoir") && `**BORDEREAU DES PIÈCES COMMUNIQUÉES**\n\n${s(c, "piece_a_prevoir")}`
        ),
      };
    }

    case "conclusions": {
      // Reproduit le formalisme observe sur le document de reference fourni
      // par l'utilisateur ("Conclusions_CORRECTES.docx") : titre et bloc
      // destinataire centres, formule d'ouverture "PLAISE À...", section
      // "I. LES PARTIES" (identite/avocat de chaque partie, seuls noms et
      // qualites en gras), "II. PLAISE AU TRIBUNAL" (phrase d'introduction
      // fixe), et bordereau des pieces en pied de document.
      const nomClientConclusions = s(c, "civilite_nom_client") || ctx.nomClient;
      const juridictionPhrase =
        s(c, "nom_juridiction") && `${articleJuridiction(s(c, "nom_juridiction"))} ${s(c, "nom_juridiction")}`;
      return {
        avant: bloc(
          centre("**CONCLUSIONS**"),
          `**Aff : ${ctx.nomAffaire}**`,
          "**Objet : Conclusions**",
          centre("**A**"),
          s(c, "destinataire") && centre(`**${s(c, "destinataire")}**`),
          espace(),
          juridictionPhrase &&
            `**PLAISE À MONSIEUR LE PRÉSIDENT ET MESDAMES ET MESSIEURS LES JUGES COMPOSANT ${juridictionPhrase} de ${ctx.ville}**`,
          espace(),
          "I. LES PARTIES",
          "POUR :",
          `**${nomClientConclusions}**${s(c, "informations_client") ? `, ${s(c, "informations_client")}` : ""}${
            s(c, "qualite_client") ? `, agissant en qualité de **${s(c, "qualite_client")}**.` : "."
          }`,
          s(c, "nom_avocat") &&
            `Ayant pour avocat : **Maître ${s(c, "nom_avocat")}**, inscrit au Barreau du Bénin${
              s(c, "adresse_cabinet") ? `, sis à l'adresse ${s(c, "adresse_cabinet")}.` : "."
            }`,
          s(c, "nom_partie_adverse") && "CONTRE :",
          s(c, "nom_partie_adverse") &&
            `**${s(c, "nom_partie_adverse")}**${
              s(c, "informations_partie_adverse") ? `, ${s(c, "informations_partie_adverse")}` : ""
            }${s(c, "qualite_partie_adverse") ? `, agissant en qualité de **${s(c, "qualite_partie_adverse")}**.` : "."}`,
          espace(),
          "II. PLAISE AU TRIBUNAL",
          "L'avocat soussigné a l'honneur de soumettre au Tribunal les conclusions suivantes pour le compte de son client."
        ),
        apres: bloc(
          espace(),
          "**Sous toutes réserves.**",
          centre(`Fait à ${ctx.ville}, le ${ctx.dateLongue}`),
          centre("(Signature de l'avocat)"),
          s(c, "nom_avocat") && centre(`**Maître ${s(c, "nom_avocat")}**`),
          espace(),
          "IV. BORDEREAU DES PIÈCES JOINTES",
          "(Obligatoire pour que le juge puisse vérifier les preuves)",
          s(c, "piece_a_prevoir")
        ),
      };
    }

    case "note_plaidoirie": {
      // Reproduit le formalisme observe sur un document reel issu du
      // pipeline Google Docs (comparaison XML fournie par l'utilisateur) :
      // en-tete centre (titre, destinataire), formule d'ouverture "PLAISE
      // À...", section "I. LES PARTIES" avec identite/avocat de chaque
      // partie (seuls les noms et qualites en gras), et signature de fin en
      // deux lignes en retrait (profondeurs differentes).
      const nomClientNote = s(c, "civilite_nom_client") || ctx.nomClient;
      const juridictionPhrase =
        s(c, "nom_juridiction") && `${articleJuridiction(s(c, "nom_juridiction"))} ${s(c, "nom_juridiction")}`;
      return {
        avant: bloc(
          titre(18, "NOTE DE PLAIDOIRIE"),
          espace(),
          `**Aff : ${ctx.nomAffaire}**`,
          centre("**A**"),
          s(c, "destinataire") && centre(`**${s(c, "destinataire")}**`),
          espace(),
          `**RG N° ${s(c, "numero_rg") || "…"} — Audience du ${ctx.dateAudienceLongue || ctx.dateLongue}**`,
          espace(),
          juridictionPhrase &&
            `**PLAISE À MONSIEUR LE PRÉSIDENT ET MESDAMES ET MESSIEURS LES JUGES COMPOSANT ${juridictionPhrase} de ${ctx.ville}**`,
          espace(),
          "I. LES PARTIES",
          "POUR :",
          `**${nomClientNote}**${s(c, "profession_client") ? `, ${s(c, "profession_client")}` : ""}${
            s(c, "informations_client") ? `, ${s(c, "informations_client")}` : ""
          }${s(c, "qualite_client") ? `, agissant en qualité de **${s(c, "qualite_client")}**.` : "."}`,
          s(c, "nom_avocat") &&
            `Ayant pour avocat : **Maître ${s(c, "nom_avocat")}**, inscrit au Barreau du Bénin${
              s(c, "adresse_cabinet") ? `, sis à l'adresse ${s(c, "adresse_cabinet")}.` : "."
            }`,
          s(c, "nom_partie_adverse") && "CONTRE :",
          s(c, "nom_partie_adverse") &&
            `**${s(c, "nom_partie_adverse")}**${
              s(c, "profession_partie_adverse") ? `, ${s(c, "profession_partie_adverse")}` : ""
            }${s(c, "informations_partie_adverse") ? `, ${s(c, "informations_partie_adverse")}` : ""}${
              s(c, "qualite_partie_adverse") ? `, agissant en qualité de **${s(c, "qualite_partie_adverse")}**.` : "."
            }`,
          s(c, "nom_avocat_partie_adverse") && `Ayant pour avocat : **${s(c, "nom_avocat_partie_adverse")}**.`,
          espace()
        ),
        apres: bloc(
          espace(),
          "**Sous toutes réserves.**",
          centre(`Fait à ${ctx.ville}, le ${ctx.dateLongue}`),
          centre("(Signature de l'avocat)"),
          s(c, "nom_avocat") && centre(`**Maître ${s(c, "nom_avocat")}**`)
        ),
      };
    }

    case "contrat": {
      return {
        avant: bloc(
          s(c, "type_contrat") || "Contrat",
          s(c, "nom_cabinet"),
          s(c, "adresse_cabinet"),
          `${ctx.ville}, le ${ctx.dateLongue}`,
          "ENTRE LES SOUSSIGNÉS :",
          `${ligne(s(c, "partie_1"), s(c, "informations_partie_1"))}, ci-après dénommé « la première partie »,`,
          "ET",
          `${ligne(s(c, "partie_2"), s(c, "informations_partie_2"))}, ci-après dénommé « la seconde partie »,`,
          "IL A ÉTÉ CONVENU ET ARRÊTÉ CE QUI SUIT :"
        ),
        apres: bloc(
          `Fait à ${ctx.ville}, le ${ctx.dateLongue}, en deux (02) exemplaires originaux, un pour chaque partie. Lu et approuvé`,
          `Pour la première partie : ${s(c, "partie_1")}`,
          `Pour la seconde partie : ${s(c, "partie_2")}`
        ),
      };
    }

    case "notification_date": {
      return {
        avant: bloc(
          s(c, "mode_notification"),
          "À l'attention de :",
          s(c, "civilite_nom_destinataire") || s(c, "destinataire"),
          s(c, "adresse_destinataire"),
          s(c, "objet") && `OBJET : ${s(c, "objet")}`,
          s(c, "civilite_appel_destinataire"),
          `J'agis en qualité de conseil de ${ligne(
            s(c, "civilite_nom_client") || ctx.nomClient,
            s(c, "informations_client")
          )}. Mon client a élu domicile en mon cabinet pour les besoins des présentes.`
        ),
        apres: bloc(
          "Nous vous remercions de l'attention que vous porterez à cette notification.",
          `Veuillez agréer, ${s(c, "civilite_appel_destinataire") || "Madame, Monsieur,"} l'expression de mes salutations distinguées.`,
          s(c, "nom_avocat") && `Maître ${s(c, "nom_avocat")}`,
          "Avocat au Barreau du Bénin",
          "(Sceau du Cabinet)"
        ),
      };
    }

    default:
      return null;
  }
}
