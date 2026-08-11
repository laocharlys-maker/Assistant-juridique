// Reconstruit, pour les exports Word/PDF generes localement (documentExport.ts),
// le formalisme juridique specifique a chaque type d'acte (identite des
// parties, huissier, greffier, juge, civilites, adresses...), a partir des
// champs composes/resolus a la generation (extraWebhookFields, voir
// routes/webActions.ts) et persistes sur Action.champsDocument.
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

// Developpe une civilite abregee ("M.", "Mme", "Mlle" - voir la liste
// deroulante du champ "Civilite d'appel" en redaction libre) en sa forme
// pleine ("Monsieur"...), pour un usage en salutation autonome ("Monsieur,",
// "Veuillez agreer, Monsieur, ...") - jamais l'abreviation elle-meme, qui n'a
// de sens que collee a un nom ("M. Agbo,"). Valeur non reconnue (ancienne
// donnee en texte libre, avant la liste deroulante) renvoyee telle quelle.
const CIVILITES_LONGUES: Record<string, string> = { "M.": "Monsieur", Mme: "Madame", Mlle: "Mademoiselle" };
function civiliteLongue(abrev: string): string {
  return CIVILITES_LONGUES[abrev] ?? abrev;
}

// Rend une liste de pieces (stockee en base sous forme d'une seule chaine
// separee par des virgules - voir "pieces_prevoir" dans webActions.ts) en
// liste a puces Markdown (voir le marqueur "- " dans markdownParse.ts),
// plutot que bout a bout sur une seule ligne.
function listePieces(label: string, piecesJointes: string | undefined): string | false {
  if (!piecesJointes) return false;
  const items = piecesJointes
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (items.length === 0) return false;
  return `**${label} :**\n${items.map((item) => `- ${item}`).join("\n")}`;
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
  ctx: FormalismeContext,
  // true pour un document cree en "redaction libre" (Lot 11 Partie B) : les
  // phrases de liaison narratives normalement ecrites par l'IA pour
  // introduire/conclure son texte ("J'agis en qualite de conseil de...",
  // "Veuillez agreer... salutations distinguees"...) n'ont pas de sens ici,
  // l'avocat redige lui-meme tout le corps du document - seules les
  // donnees de base et les formules de mise en page fixes (identite,
  // destinataire, objet, bloc de signature) restent generees. Uniquement
  // applique aux types explicitement ajustes pour la redaction libre (voir
  // les cas "mise_en_demeure" et "notification_date" ci-dessous) - les
  // autres types ne changent jamais de comportement selon ce drapeau.
  redactionLibre = false
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
          listePieces("Pièces à prévoir", ctx.piecesPrevoir),
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
          s(c, "nationalite_client") ? `, de nationalité ${s(c, "nationalite_client")}` : ""
        }${s(c, "informations_client") ? `, ${s(c, "informations_client")}` : ""}${s(c, "adresse_client") ? `, demeurant à **${s(c, "adresse_client")}**` : ""}, élisant domicile au cabinet de son conseil, **${
          s(c, "nom_avocat") || ""
        }**, Avocat au Barreau du Bénin${s(c, "adresse_cabinet") ? `, y demeurant à **${s(c, "adresse_cabinet")}**` : ""},`
      );
      const juridictionPhrase =
        s(c, "nom_chambre") ||
        (s(c, "nom_juridiction") && `${articleJuridiction(s(c, "nom_juridiction"))} ${s(c, "nom_juridiction")}`);
      const annee = anneeEnLettres(new Date().getFullYear()).toUpperCase();
      return {
        avant: bloc(
          titre(20, "ASSIGNATION"),
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
        apres: bloc(
          plein("SOUS TOUTES RÉSERVES"),
          espace(),
          `Fait à ${ctx.ville}, le ${ctx.dateLongue}`,
          s(c, "nom_avocat") && centre(`**Maître ${s(c, "nom_avocat")}**`),
          centre("Avocat au Barreau du Bénin")
        ),
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
          droite(`${ctx.ville}, le ${ctx.dateLongue}`),
          s(c, "mode_notification") && `**${s(c, "mode_notification")}**`,
          espace(),
          retrait(4320, "**À l'attention de :**"),
          retrait(4320, `**${ligneDestinataire}**`),
          s(c, "profession_destinataire") && retrait(4320, `**${s(c, "profession_destinataire")}**`),
          s(c, "informations_destinataire") && retrait(4320, `**${s(c, "informations_destinataire")}**`),
          espace(),
          s(c, "objet_mise_en_demeure") && `**OBJET : ${s(c, "objet_mise_en_demeure")}**`,
          s(c, "civilite_appel_destinataire") && civiliteLongue(s(c, "civilite_appel_destinataire")),
          // Phrase de liaison ecrite par l'IA pour introduire son texte -
          // sans objet en redaction libre, l'avocat redige lui-meme tout
          // le corps de la mise en demeure (voir le parametre redactionLibre).
          !redactionLibre &&
            `J'agis par la présente en qualité de conseil de ${ctx.nomClient}${
              s(c, "adresse_client") ? `, demeurant à ${s(c, "adresse_client")}` : ""
            }, qui m'a confié la défense de ses intérêts.`
        ),
        apres: bloc(
          !redactionLibre && "Sous toutes réserves dont mon client entend se prévaloir en justice.",
          !redactionLibre &&
            `Veuillez agréer, ${
              s(c, "civilite_appel_destinataire") ? civiliteLongue(s(c, "civilite_appel_destinataire")) : "Madame, Monsieur,"
            } l'expression de mes salutations distinguées.`,
          s(c, "nom_avocat") && retrait(5040, `**Maître ${s(c, "nom_avocat")}**`),
          retrait(5040, "**Avocat au Barreau du Bénin**")
        ),
      };
    }

    case "plainte": {
      // Case "Avec constitution de partie civile" (checkbox dediee, voir
      // nouvelle-action.html) - avant ce champ, ce texte se basait sur
      // mode_redaction.includes("civile"), un test toujours faux (l'enum ne
      // contient que "avocat"/"plaignant") : jamais appliqué en pratique.
      const civileTxt = s(c, "constitution_partie_civile") ? "avec constitution de partie civile" : "";
      const nomClientPlainte = s(c, "civilite_nom_client") || ctx.nomClient;
      const nomDefendeurPlainte = s(c, "civilite_nom_defendeur") || s(c, "nom_defendeur");

      // Derive la civilite d'appel correcte depuis le champ destinataire (ex :
      // "Mme la Présidente du Tribunal" → "Madame la Présidente") afin que la
      // salutation et la formule de politesse soient cohérentes avec l'adresse.
      function civiliteAppelMagistrat(dest: string): string {
        const d = dest.toLowerCase();
        const feminin =
          d.startsWith("mme") || d.startsWith("madame") || d.includes("présidente") || d.includes("procureure");
        if (feminin) {
          if (d.includes("présidente")) return "Madame la Présidente";
          if (d.includes("procureure")) return "Madame la Procureure de la République";
          return "Madame";
        }
        if (d.includes("procureur")) return "Monsieur le Procureur de la République";
        if (d.includes("président")) return "Monsieur le Président";
        return "Monsieur le Procureur de la République";
      }
      const appelMagistrat = civiliteAppelMagistrat(s(c, "destinataire") || "");

      // Deux presentations tres differentes selon qui redige (voir le champ
      // mode_redaction dans schemas/webForms.ts) : l'avocat pour son client
      // represente (formalisme verifie sur "Plainte_CORRECTES.docx" -
      // en-tete cabinet, blocs POUR/CONTRE avec Maitre, QUALIFICATION DES
      // FAITS separee), ou le plaignant lui-meme, sans representation
      // (formalisme verifie sur "Plainte_Individ.docx" - pas d'en-tete
      // cabinet, identite du plaignant en guise d'expediteur, "LES FAITS :"
      // / "FONDEMENTS :", demandes en liste a puces avec le verbe en gras).
      if (s(c, "mode_redaction") === "plaignant") {
        // Reproduit le formalisme observe sur un document de reference fourni
        // par l'utilisateur : identite du plaignant en tete (en haut a
        // gauche, avant "Réf :"), pas de phrase figee annoncant le mis en
        // cause ou la qualification (le plaignant les developpe lui-meme
        // dans "LES FAITS :", voir le gabarit de redaction libre
        // correspondant) et pas de formule de politesse de cloture generique
        // avant la signature.
        return {
          avant: bloc(
            droite(`${ctx.ville}, le ${ctx.dateLongue}`),
            `**${nomClientPlainte}**`,
            s(c, "profession_client") && `**${s(c, "profession_client")}**`,
            s(c, "nationalite_client") && `**De nationalité ${s(c, "nationalite_client")}**`,
            s(c, "adresse_client") && `**Demeurant à : ${s(c, "adresse_client")}**`,
            "Réf :",
            centre("À"),
            s(c, "destinataire") && centre(`**${s(c, "destinataire")}**`),
            // Juridiction (et chambre, si precisee) directement sous le
            // destinataire - meme principe que pour les Conclusions/Note de
            // plaidoirie/Assignation/Plainte (mode avocat).
            s(c, "nom_juridiction") &&
              centre(
                `**${s(c, "nom_juridiction")} de ${ctx.ville}${s(c, "nom_chambre") ? `, ${s(c, "nom_chambre")}` : ""}**`
              ),
            // Pas d'espace apres "OBJET :" - reproduit tel quel le
            // formalisme observe sur le document de reference.
            `**OBJET :Plainte${civileTxt ? ` ${civileTxt} ` : " "}pour des faits de ${
              s(c, "qualification_infraction") || "..."
            }**`,
            `${appelMagistrat},`
          ),
          apres: bloc(retrait(5760, `**${nomClientPlainte}**`), retrait(5760, "[Signature]")),
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
          centre("À"),
          s(c, "destinataire") && centre(`**${s(c, "destinataire")}**`),
          // Juridiction (et chambre, si precisee) directement sous le
          // destinataire - meme principe que pour les Conclusions/Note de
          // plaidoirie : le bloc adresse doit rester lisible seul.
          s(c, "nom_juridiction") &&
            centre(
              `**${s(c, "nom_juridiction")} de ${ctx.ville}${s(c, "nom_chambre") ? `, ${s(c, "nom_chambre")}` : ""}**`
            ),
          // "Contre X pour Y" repete ici l'identite du mis en cause et la
          // qualification des faits (deja detaillees plus bas dans le bloc
          // CONTRE et etaient avant repetees une 3e fois dans une phrase
          // figee "J'ai l'honneur d'intervenir...", retiree - voir
          // document de reference fourni par l'utilisateur, qui n'a plus
          // cette phrase).
          `**OBJET : Plainte${civileTxt ? ` ${civileTxt}` : ""}${
            nomDefendeurPlainte ? ` contre ${nomDefendeurPlainte}` : ""
          }${s(c, "qualification_infraction") ? ` pour ${s(c, "qualification_infraction")}` : ""}**`,
          `POUR **${nomClientPlainte}**${s(c, "profession_client") ? `, ${s(c, "profession_client")}` : ""}${
            s(c, "nationalite_client") ? `, de nationalité ${s(c, "nationalite_client")}` : ""
          }${
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
              s(c, "nationalite_defendeur") ? `, de nationalité ${s(c, "nationalite_defendeur")}` : ""
            }${
              s(c, "adresse_defendeur") ? `, demeurant à ${s(c, "adresse_defendeur")}.` : "."
            }`,
          `${appelMagistrat},`
        ),
        apres: bloc(
          "Sous toutes réserves que de droit.",
          `Veuillez agréer, ${appelMagistrat}, l'expression de ma très haute considération.`,
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
        ? `ayant pour Conseil Maître ${s(c, "nom_avocat")}, Avocat au Barreau du Bénin${
            s(c, "adresse_cabinet")
              ? `, y demeurant élisant domicile en son cabinet sis ${s(c, "adresse_cabinet")}.`
              : "."
          }`
        : "";
      // Identite du client et de la partie adverse chacune sur une seule
      // ligne (nom, nationalite, adresse/informations, conseil separes par
      // des virgules) - voir document de reference fourni par l'utilisateur,
      // jamais une ligne par information.
      const identiteClientRequete = ligne(
        `${s(c, "civilite_nom_client") || ctx.nomClient}${qualiteClient}`,
        s(c, "nationalite_client") && `de nationalité ${s(c, "nationalite_client")}`,
        s(c, "informations_client"),
        conseil
      );
      const defendeur = ligne(
        s(c, "civilite_nom_defendeur") || s(c, "nom_defendeur"),
        s(c, "profession_defendeur"),
        s(c, "nationalite_defendeur") && `de nationalité ${s(c, "nationalite_defendeur")}`,
        s(c, "adresse_defendeur") && `demeurant ${s(c, "adresse_defendeur")}`
      );
      // Destinataire + juridiction sur une seule ligne centree (ex: "M. le
      // Président du Tribunal de Première Instance de Cotonou") - voir
      // document de reference fourni par l'utilisateur.
      const destinataireRequete = s(c, "nom_juridiction")
        ? `${s(c, "destinataire")} ${possessifJuridiction(s(c, "nom_juridiction"))} ${s(c, "nom_juridiction")} de ${ctx.ville}`
        : s(c, "destinataire");
      return {
        avant: bloc(
          droite(`Fait à ${ctx.ville}, le ${ctx.dateLongue}`),
          espace(),
          s(c, "nom_cabinet"),
          s(c, "adresse_cabinet") && `**${s(c, "adresse_cabinet")}**`,
          espace(),
          centre("À"),
          centre(destinataireRequete),
          espace(),
          s(c, "objet") && `**OBJET : ${s(c, "objet")}**`,
          espace(),
          "REQUÊTE",
          "POUR :",
          identiteClientRequete,
          defendeur && "CONTRE :",
          defendeur
          // Pas de seconde ligne "À Madame, Monsieur," ici : deja adressee au
          // destinataire choisi en tete de la requete (voir centre(destinataire)
          // plus haut) - une seconde salutation generique ferait doublon.
        ),
        apres: bloc(
          // Liste a puces (une piece par ligne, saisies separees par des
          // virgules dans le formulaire) plutot que le texte brut tel que
          // saisi - voir document de reference fourni par l'utilisateur.
          s(c, "piece_a_prevoir") &&
            `BORDEREAU DES PIÈCES COMMUNIQUÉES\n\n${s(c, "piece_a_prevoir")
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
              .map((item) => `- ${item}`)
              .join("\n")}`,
          "Sous toutes réserves que de droit.",
          centre(s(c, "nom_avocat") && `Maître ${s(c, "nom_avocat")}`),
          centre("Avocat au Barreau du Bénin")
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
          }**${s(c, "nationalite_client") ? `, de nationalité ${s(c, "nationalite_client")}` : ""}${
            s(c, "informations_client") ? `, ${s(c, "informations_client")}` : ""
          }${
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
          titre(18, "CONCLUSIONS"),
          espace(),
          `**Aff : ${ctx.nomAffaire}**`,
          "**Objet : Conclusions**",
          centre("**À**"),
          s(c, "destinataire") && centre(`**${s(c, "destinataire")}**`),
          // Juridiction (et chambre, si precisee) directement sous le
          // destinataire - en plus de la phrase d'ouverture "PLAISE À..."
          // plus bas, qui les mentionne aussi mais dans une formule figee :
          // le bloc adresse doit rester lisible seul, sans devoir chercher
          // l'information plus loin dans le document.
          s(c, "nom_juridiction") &&
            centre(
              `**${s(c, "nom_juridiction")} de ${ctx.ville}${s(c, "nom_chambre") ? `, ${s(c, "nom_chambre")}` : ""}**`
            ),
          espace(),
          juridictionPhrase &&
            `**PLAISE À MONSIEUR LE PRÉSIDENT ET MESDAMES ET MESSIEURS LES JUGES COMPOSANT ${juridictionPhrase} de ${ctx.ville}**`,
          espace(),
          "I. LES PARTIES",
          "POUR :",
          `**${nomClientConclusions}**${
            s(c, "nationalite_client") ? `, de nationalité ${s(c, "nationalite_client")}` : ""
          }${s(c, "informations_client") ? `, ${s(c, "informations_client")}` : ""}${
            s(c, "qualite_client") ? `, agissant en qualité de **${s(c, "qualite_client")}**.` : "."
          }`,
          s(c, "nom_avocat") &&
            `Ayant pour avocat : **Maître ${s(c, "nom_avocat")}**, inscrit au Barreau du Bénin${
              s(c, "adresse_cabinet") ? `, sis à l'adresse ${s(c, "adresse_cabinet")}.` : "."
            }`,
          s(c, "nom_partie_adverse") && "CONTRE :",
          s(c, "nom_partie_adverse") &&
            `**${s(c, "nom_partie_adverse")}**${
              s(c, "nationalite_partie_adverse") ? `, de nationalité ${s(c, "nationalite_partie_adverse")}` : ""
            }${
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
          titre(20, "NOTE DE PLAIDOIRIE"),
          espace(),
          `**Aff : ${ctx.nomAffaire}**`,
          centre("**À**"),
          s(c, "destinataire") && centre(`**${s(c, "destinataire")}**`),
          // Juridiction (et chambre, si precisee) directement sous le
          // destinataire - meme principe que pour les Conclusions : le bloc
          // adresse doit rester lisible seul, sans devoir chercher
          // l'information dans la phrase d'ouverture "PLAISE À..." plus bas.
          s(c, "nom_juridiction") &&
            centre(
              `**${s(c, "nom_juridiction")} de ${ctx.ville}${s(c, "nom_chambre") ? `, ${s(c, "nom_chambre")}` : ""}**`
            ),
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
          centre(`Fait à ${ctx.ville}, le ${ctx.dateLongue}`),
          centre("(Signature de l'avocat)"),
          s(c, "nom_avocat") && centre(`**Maître ${s(c, "nom_avocat")}**`)
        ),
      };
    }

    case "contrat": {
      // Reproduit le formalisme observe sur le document de reference fourni
      // par l'utilisateur ("Contrat_Correct.docx") : titre centre en gras,
      // en-tete cabinet en gras, date NON grasse et alignee a gauche (pas
      // a droite, contrairement aux autres types d'actes), "ENTRE LES
      // SOUSSIGNÉS :" et "ET" en texte normal (pas de gras automatique
      // malgre les majuscules), seuls les noms des parties en gras dans la
      // phrase d'identification, et la signature de fin sur une seule
      // ligne avec les deux noms en gras (approximation en deux colonnes
      // via des espaces, faute de mise en page multi-colonnes).
      const partie1 = s(c, "partie_1");
      const partie2 = s(c, "partie_2");
      // "CONTRAT DE " est ajoute automatiquement ici - si la valeur saisie
      // commence deja par "Contrat de" (malgre l'exemple du formulaire qui
      // ne l'inclut plus), on evite de le repeter en double.
      const typeContrat = s(c, "type_contrat").replace(/^contrat\s+de\s+/i, "");
      return {
        avant: bloc(
          titre(20, typeContrat ? `CONTRAT DE ${typeContrat.toUpperCase()}` : "CONTRAT"),
          s(c, "nom_cabinet") && `**${s(c, "nom_cabinet")}**`,
          s(c, "adresse_cabinet") && `**${s(c, "adresse_cabinet")}**`,
          "**Barreau du Bénin**",
          `${ctx.ville}, le ${ctx.dateLongue}`,
          plein("ENTRE LES SOUSSIGNÉS :"),
          partie1 &&
            `${ligne(
              `**${partie1}**`,
              s(c, "nationalite_partie_1") && `de nationalité ${s(c, "nationalite_partie_1")}`,
              s(c, "informations_partie_1")
            )}, ci-après dénommé « la première partie »,`,
          plein("ET"),
          partie2 &&
            `${ligne(
              `**${partie2}**`,
              s(c, "nationalite_partie_2") && `de nationalité ${s(c, "nationalite_partie_2")}`,
              s(c, "informations_partie_2")
            )}, ci-après dénommé « la seconde partie »,`
        ),
        apres: bloc(
          `Fait à ${ctx.ville}, le ${ctx.dateLongue}, en deux (02) exemplaires originaux, un pour chaque partie. Lu et approuvé`,
          "Pour la première partie                                          Pour la seconde partie",
          "_____________________                                   _____________________",
          `**${partie1 || ""}**${"                                                              "}**${partie2 || ""}**`
        ),
      };
    }

    case "notification_date": {
      // Meme cabinet, meme convention "PAR EXPLOIT DE COMMISSAIRE DE
      // JUSTICE" que la Mise en demeure (formalisme verifie par XML) :
      // en-tete cabinet en gras, date alignee a droite, bloc destinataire
      // en gras et en retrait (pas centre), signature de fin en retrait.
      const destinataireNotif =
        s(c, "civilite_nom_destinataire") || s(c, "destinataire");
      return {
        avant: bloc(
          s(c, "nom_cabinet") && `**${s(c, "nom_cabinet")}**`,
          s(c, "adresse_cabinet") && `**${s(c, "adresse_cabinet")}**`,
          droite(`${ctx.ville}, le ${ctx.dateLongue}`),
          s(c, "mode_notification") && `**${s(c, "mode_notification")}**`,
          espace(),
          destinataireNotif && retrait(4320, "**À l'attention de :**"),
          destinataireNotif && retrait(4320, `**${destinataireNotif}**`),
          s(c, "adresse_destinataire") && retrait(4320, `**${s(c, "adresse_destinataire")}**`),
          espace(),
          s(c, "objet") && `**OBJET : ${s(c, "objet")}**`,
          s(c, "civilite_appel_destinataire"),
          // Phrase de liaison ecrite par l'IA pour introduire son texte -
          // sans objet en redaction libre, l'avocat redige lui-meme tout
          // le corps de la notification (voir le parametre redactionLibre).
          !redactionLibre &&
            `J'agis en qualité de conseil de ${ligne(
              s(c, "civilite_nom_client") || ctx.nomClient,
              s(c, "informations_client")
            )}. Mon client a élu domicile en mon cabinet pour les besoins des présentes.`
        ),
        apres: bloc(
          !redactionLibre && "Nous vous remercions de l'attention que vous porterez à cette notification.",
          !redactionLibre &&
            `Veuillez agréer, ${
              s(c, "civilite_appel_destinataire") ? civiliteLongue(s(c, "civilite_appel_destinataire")) : "Madame, Monsieur,"
            } l'expression de mes salutations distinguées.`,
          s(c, "nom_avocat") && retrait(5760, `**Maître ${s(c, "nom_avocat")}**`),
          retrait(5760, "**Avocat au Barreau du Bénin**"),
          retrait(5760, "(Sceau du Cabinet)")
        ),
      };
    }

    default:
      return null;
  }
}
