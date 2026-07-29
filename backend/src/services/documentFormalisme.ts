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
      const juridiction = ligne(s(c, "nom_juridiction"), s(c, "nom_chambre"));
      return {
        avant: bloc(
          "COMPTE RENDU D'AUDIENCE",
          ctx.dateAudienceLongue && `DATE DE L'AUDIENCE : ${ctx.dateAudienceLongue}`,
          juridiction && `JURIDICTION : ${juridiction}`,
          s(c, "nom_juge") && `PRÉSIDENT DE CHAMBRE : ${s(c, "nom_juge")}`,
          s(c, "nom_greffier") && `GREFFIER : ${s(c, "nom_greffier")}`,
          `AFFAIRE : ${ctx.nomAffaire}`,
          `RÉFÉRENCE DOSSIER : ${ligne(ctx.numeroDossier, s(c, "numero_rg") && `RG n° ${s(c, "numero_rg")}`)}`,
          s(c, "objet_litige") && `OBJET DU LITIGE : ${s(c, "objet_litige")}`
        ),
        apres: bloc(
          ctx.prochaineAudienceLongue && `Prochaine date d'audience : ${ctx.prochaineAudienceLongue}`,
          ctx.piecesPrevoir && `Pièces à prévoir : ${ctx.piecesPrevoir}`,
          `Fait à ${ctx.ville}, le ${ctx.dateLongue}.`,
          s(c, "nom_avocat")
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
        s(c, "nom_chambre") || (s(c, "nom_juridiction") && `le ${s(c, "nom_juridiction")}`);
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
        ? "avec constitution de partie civile "
        : "";
      return {
        avant: bloc(
          s(c, "civilite_nom_client") || ctx.nomClient,
          s(c, "profession_client"),
          s(c, "adresse_client") && `Demeurant à : ${s(c, "adresse_client")}`,
          "À",
          s(c, "destinataire") || "M. le Procureur de la République",
          `OBJET : Plainte ${civileTxt}pour des faits de ${s(c, "qualification_infraction") || "..."}`,
          "Monsieur le Procureur de la République,",
          `J'ai l'honneur de porter plainte entre vos mains contre le nommé ${
            s(c, "civilite_nom_defendeur") || s(c, "nom_defendeur")
          }${s(c, "adresse_defendeur") ? `, demeurant à ${s(c, "adresse_defendeur")}` : ""}, pour des faits de ${
            s(c, "qualification_infraction") || "..."
          } prévus et réprimés par le Code pénal en vigueur en République du Bénin.`
        ),
        apres: bloc(
          "Je me tiens à la disposition de vos services de police ou de gendarmerie pour toute audition ou confrontation nécessaire à la manifestation de la vérité.",
          "Je vous prie d'agréer, Monsieur le Procureur de la République, l'assurance de ma très haute considération.",
          s(c, "civilite_nom_client") || ctx.nomClient,
          "[Signature de l'Avocat]"
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
      return {
        avant: bloc(
          "RÉPUBLIQUE DU BÉNIN",
          s(c, "destinataire"),
          s(c, "objet") && `OBJET : ${s(c, "objet")}`,
          ligne(s(c, "civilite_nom_client") || ctx.nomClient, s(c, "informations_client"))
        ),
        apres: bloc(
          s(c, "delai_opposition_jours") && `Délai d'opposition : ${s(c, "delai_opposition_jours")} jours`,
          `Fait à ${ctx.ville}, le ${ctx.dateLongue}`
        ),
      };
    }

    case "conclusions": {
      const pour = ligne(s(c, "qualite_client"), ctx.nomClient, s(c, "informations_client"));
      const contre = ligne(s(c, "qualite_partie_adverse"), s(c, "nom_partie_adverse"), s(c, "informations_partie_adverse"));
      return {
        avant: bloc(
          "CONCLUSIONS",
          `POUR : ${pour}`,
          s(c, "nom_avocat") &&
            `Ayant pour conseil ${s(c, "nom_avocat")}, Avocat au Barreau du Bénin${
              s(c, "adresse_cabinet") ? `, demeurant à ${s(c, "adresse_cabinet")}` : ""
            }`,
          contre && `CONTRE : ${contre}`,
          s(c, "destinataire") && `Devant ${s(c, "destinataire")}`,
          "PLAISE AU TRIBUNAL"
        ),
        apres: bloc(
          s(c, "piece_a_prevoir") && `Bordereau des pièces communiquées :\n${s(c, "piece_a_prevoir")}`,
          `Fait à ${ctx.ville}, le ${ctx.dateLongue}`,
          s(c, "nom_avocat") && `Maître ${s(c, "nom_avocat")}`,
          "Avocat au Barreau du Bénin"
        ),
      };
    }

    case "note_plaidoirie": {
      const pour = ligne(
        s(c, "civilite_nom_client") || ctx.nomClient,
        s(c, "profession_client"),
        s(c, "informations_client")
      );
      const contre = ligne(
        s(c, "nom_partie_adverse"),
        s(c, "profession_partie_adverse"),
        s(c, "informations_partie_adverse")
      );
      return {
        avant: bloc(
          "NOTE DE PLAIDOIRIE",
          `POUR : ${pour}`,
          s(c, "nom_avocat") && `Ayant pour conseil ${s(c, "nom_avocat")}, Avocat au Barreau du Bénin`,
          contre && `CONTRE : ${contre}`,
          s(c, "nom_avocat_partie_adverse") && `Ayant pour conseil ${s(c, "nom_avocat_partie_adverse")}`,
          s(c, "destinataire") && `Devant ${s(c, "destinataire")}`
        ),
        apres: bloc(
          `Fait à ${ctx.ville}, le ${ctx.dateLongue}`,
          s(c, "nom_avocat") && `Maître ${s(c, "nom_avocat")}`,
          "Avocat au Barreau du Bénin"
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
