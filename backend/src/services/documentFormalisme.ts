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
      const identiteClient = ligne(
        s(c, "civilite_nom_client") || ctx.nomClient,
        s(c, "profession_client"),
        s(c, "informations_client"),
        s(c, "adresse_client")
      );
      const electionDomicile = s(c, "nom_avocat")
        ? `, élisant domicile au cabinet de son conseil, ${s(c, "nom_avocat")}, Avocat au Barreau du Bénin${
            s(c, "adresse_cabinet") ? `, ${s(c, "adresse_cabinet")}` : ""
          },`
        : ",";
      const defendeur = s(c, "adresse_defendeur")
        ? `${s(c, "nom_defendeur")}, demeurant à ${s(c, "adresse_defendeur")}`
        : s(c, "nom_defendeur");
      const juridictionPhrase =
        s(c, "nom_chambre") || (s(c, "nom_juridiction") && `le ${s(c, "nom_juridiction")}`);
      const requerant = bloc(
        "ASSIGNATION",
        `L'AN ${new Date().getFullYear()}, et le ${ctx.dateLongue},`,
        "À LA REQUÊTE DE :",
        `${identiteClient}${electionDomicile}`,
        s(c, "nom_huissier") &&
          `J'AI, ${s(c, "nom_huissier")}, COMMISSAIRE DE JUSTICE près le ${s(c, "nom_juridiction") || "Tribunal"} de ${
            ctx.ville
          }${s(c, "adresse_cabinet") ? `, y demeurant et domicilié à ${s(c, "adresse_cabinet")}` : ""} SOUSSIGNÉ :`,
        defendeur && "DONNÉ ASSIGNATION À :",
        defendeur,
        juridictionPhrase &&
          `De comparaître par-devant Monsieur le Président et les Juges composant ${juridictionPhrase} de ${ctx.ville}, siégeant en l'une des salles ordinaires des audiences dudit Tribunal.`,
        "TRÈS IMPORTANT — AVERTISSEMENT AU DÉFENDEUR :",
        "Conformément à la loi, vous êtes tenu de constituer un avocat dans un délai de 15 jours à compter de la date du présent acte pour vous représenter. À défaut, un jugement pourra être rendu contre vous sur les seuls éléments fournis par votre adversaire."
      );
      return {
        avant: requerant,
        apres: bloc("SOUS TOUTES RÉSERVES", `Fait à ${ctx.ville}, le ${ctx.dateLongue}`),
      };
    }

    case "mise_en_demeure": {
      const destinataire = ligne(
        s(c, "civilite_nom_destinataire") || s(c, "destinataire"),
        s(c, "profession_destinataire")
      );
      return {
        avant: bloc(
          s(c, "mode_notification"),
          "À l'attention de :",
          destinataire,
          s(c, "informations_destinataire"),
          s(c, "objet_mise_en_demeure") && `OBJET : ${s(c, "objet_mise_en_demeure")}`,
          s(c, "civilite_appel_destinataire"),
          `J'agis par la présente en qualité de conseil de ${ctx.nomClient}${
            s(c, "adresse_client") ? `, demeurant à ${s(c, "adresse_client")}` : ""
          }, qui m'a confié la défense de ses intérêts.`
        ),
        apres: bloc(
          "Sous toutes réserves dont mon client entend se prévaloir en justice.",
          `Veuillez agréer, ${s(c, "civilite_appel_destinataire") || "Madame, Monsieur,"} l'expression de mes salutations distinguées.`,
          s(c, "nom_avocat") && `Maître ${s(c, "nom_avocat")}`,
          "Avocat au Barreau du Bénin"
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
          "A",
          s(c, "destinataire"),
          s(c, "objet") && `OBJET : ${s(c, "objet")}`,
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
          s(c, "nom_avocat") && `Maître ${s(c, "nom_avocat")}`,
          "Avocat au Barreau du Bénin",
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
