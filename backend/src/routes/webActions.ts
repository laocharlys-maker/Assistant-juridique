import { Router, Response } from "express";
import { z } from "zod";
import pdfParse from "pdf-parse";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { getLlmProvider, LlmProvider } from "../services/llm";
import { isMissingConfigurationError } from "../lib/configurationError";
import { isNetworkFetchError, isGeminiQuotaError } from "../lib/networkError";
import { logAuditStep } from "../services/audit";
import { espace } from "../services/documentFormalisme";
import { webActionFormSchema } from "../schemas/webForms";
import { redigerAvecPseudonymisation, type ChampIdentifiantInput } from "../security/anonymizer";
import { OrphanTokenError } from "../security/deanonymizer";
import {
  NOTES_SYSTEM_PROMPT,
  NOTES_STRATEGIE_SUGGESTION_SYSTEM_PROMPT,
  REDAC_SYSTEM_PROMPT,
  CONCLUSIONS_SYSTEM_PROMPT,
  NOTE_PLAIDOIRIE_SYSTEM_PROMPT,
  ASSIGNATION_SYSTEM_PROMPT,
  MISE_EN_DEMEURE_SYSTEM_PROMPT,
  JURISPRUDENCE_SYSTEM_PROMPT,
  RECHERCHE_JURIDIQUE_SYSTEM_PROMPT,
  PLAINTE_SYSTEM_PROMPT,
  CONTRAT_SYSTEM_PROMPT,
  CLAUSE_FORCE_MAJEURE,
  NOTIFICATION_DATE_SYSTEM_PROMPT,
  REQUETE_SYSTEM_PROMPT,
  PROJET_ORDONNANCE_SYSTEM_PROMPT,
  buildNotesUserPrompt,
  buildNotesStrategieSuggestionUserPrompt,
  buildRedacUserPrompt,
  buildConclusionsUserPrompt,
  buildNotePlaidoirieUserPrompt,
  buildAssignationUserPrompt,
  buildMiseEnDemeureUserPrompt,
  buildJurisprudenceUserPrompt,
  buildRechercheJuridiqueUserPrompt,
  buildPlainteUserPrompt,
  buildContratUserPrompt,
  buildNotificationDateUserPrompt,
  buildRequeteUserPrompt,
  buildProjetOrdonnanceUserPrompt,
} from "../prompts/webRedaction";
import { ActionOutput } from "../schemas/action";
import { searchJurisprudence } from "../services/rag";
import { construireSourcesDisponibles, formatSourcesPourPrompt, validerEtFiltrerCitations } from "../services/jurisprudence/grounding";
import { rechercherJurisprudenceTavily } from "../services/jurisprudence/rechercheTavily";
import { rechercherJuridiqueTavily } from "../services/recherche-juridique/rechercheTavily";
import { summarizeLongText } from "../services/resumePdf";
import { translateText, extractTextFromDocument } from "../services/traduction";
import { aiActionsLimiter } from "../middleware/rateLimit";
import { formatDateLongue } from "../utils/dateFormat";
import { computeNomDocument } from "../utils/documentNaming";
import { WebActionForm } from "../schemas/webForms";

export const webActionsRouter = Router();

// La plaidoirie (redac) reste sur ce traitement simple (dossier existant +
// contexte + axes d'argumentation -> un seul bloc "argumentaire"). Les
// Conclusions, la Note de plaidoirie et l'Assignation ont chacune leur
// propre traitement (voir plus bas) : texte structure en blocs distincts
// pour s'inserer dans un template Google Docs a plusieurs sections.
const TEXTE_JURIDIQUE_CONFIG = {
  redac: { systemPrompt: REDAC_SYSTEM_PROMPT, categorieTexte: "Plaidoirie" },
} as const;

// Compose une description civile du client ("ne(e) le ... a ..., demeurant
// a ...") a partir de sa fiche en base, pour la section "I. LES PARTIES"
// des conclusions - n'utilise QUE ce qui est deja renseigne sur la fiche,
// jamais invente. Renvoie null si rien d'exploitable n'est disponible (dans
// ce cas le formulaire propose un champ de secours, voir plus bas).
function composerInformationsClient(client: {
  dateNaissance: Date | null;
  lieuNaissance: string | null;
  quartierResidence: string | null;
  rue: string | null;
  maison: string | null;
  autrePrecision: string | null;
} | null): string | null {
  if (!client) return null;
  const parts: string[] = [];
  if (client.dateNaissance) {
    const dateStr = formatDateLongue(client.dateNaissance);
    parts.push(client.lieuNaissance ? `né(e) le ${dateStr} à ${client.lieuNaissance}` : `né(e) le ${dateStr}`);
  } else if (client.lieuNaissance) {
    parts.push(`né(e) à ${client.lieuNaissance}`);
  }
  const adresse = [client.quartierResidence, client.rue, client.maison, client.autrePrecision].filter(Boolean);
  if (adresse.length > 0) parts.push(`demeurant à ${adresse.join(", ")}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

// Variante pour l'Assignation : naissance + piece d'identite + situation
// matrimoniale (sans l'adresse, qui a sa propre balise separee sur cet
// acte - voir composerAdresseClient ci-dessous).
function composerInformationsClientAssignation(client: {
  dateNaissance: Date | null;
  lieuNaissance: string | null;
  numeroPieceIdentite: string | null;
  situationMatrimoniale: string | null;
} | null): string | null {
  if (!client) return null;
  const parts: string[] = [];
  if (client.dateNaissance) {
    const dateStr = formatDateLongue(client.dateNaissance);
    parts.push(client.lieuNaissance ? `né(e) le ${dateStr} à ${client.lieuNaissance}` : `né(e) le ${dateStr}`);
  } else if (client.lieuNaissance) {
    parts.push(`né(e) à ${client.lieuNaissance}`);
  }
  if (client.numeroPieceIdentite) parts.push(`titulaire de la pièce d'identité n°${client.numeroPieceIdentite}`);
  if (client.situationMatrimoniale) parts.push(client.situationMatrimoniale);
  return parts.length > 0 ? parts.join(", ") : null;
}

// Adresse seule (sans prefixe "demeurant a", deja present en dur sur le
// template de l'Assignation juste avant la balise).
function composerAdresseClient(client: {
  quartierResidence: string | null;
  rue: string | null;
  maison: string | null;
  autrePrecision: string | null;
} | null): string | null {
  if (!client) return null;
  const adresse = [client.quartierResidence, client.rue, client.maison, client.autrePrecision].filter(Boolean);
  return adresse.length > 0 ? adresse.join(", ") : null;
}

// Assemble civilite + nom en un seul bloc ("M. KODJO Marcelline"), pour
// eviter de laisser au template deux balises a juxtaposer manuellement
// (risque d'espace en trop si la civilite est vide, ex: personne morale).
function assemblerCivilite(civilite: string | null, nom: string): string {
  return civilite ? `${civilite} ${nom}` : nom;
}

// Met en gras le verbe (ou groupe de mots TOUT EN MAJUSCULES) qui ouvre
// chaque ligne d'un dispositif ("CONSTATER que...", "DIRE ET JUGER que...",
// "ORDONNER l'arret...") - jamais le reste de la phrase. Utilise pour le
// dispositif de la Note de plaidoirie, redige par l'IA a partir des
// demandes de l'avocat : seul ce prefixe TOUT EN MAJUSCULES, deja choisi
// par l'avocat/l'IA comme verbe d'action, est mis en valeur.
function mettreEnGrasVerbeInitial(texte: string): string {
  return texte
    .split("\n")
    .map((ligne) => {
      // Tolere un tiret/puce residuel en tete de ligne (le prompt demande
      // desormais des paragraphes, mais on reste robuste si le LLM en
      // laisse un malgre tout) : on le preserve tel quel avant le gras.
      const prefixMatch = ligne.match(/^(\s*[-*]\s+)(.*)$/);
      const prefixe = prefixMatch ? prefixMatch[1] : "";
      const reste = prefixMatch ? prefixMatch[2] : ligne;
      const m = reste.match(/^((?:[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'-]*\s+)*[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'-]*)\b/);
      if (!m || m[1].length < 3 || m[1] === reste.trim()) return ligne;
      return `${prefixe}**${m[1]}**${reste.slice(m[1].length)}`;
    })
    .join("\n");
}

// Meme principe que mettreEnGrasVerbeInitial, mais pour un texte saisi
// directement par l'avocat (pas reecrit par l'IA en majuscules) : le premier
// mot de chaque ligne (le verbe d'action - "Enjoindre", "Payer", "Interdire"...)
// est mis en majuscules et en gras, quelle que soit la casse d'origine.
// Utilise pour le dispositif "PAR CES MOTIFS" de la Requete.
function majusculerPremierVerbe(texte: string): string {
  return texte
    .split("\n")
    .map((ligne) => {
      const prefixMatch = ligne.match(/^(\s*[-*]\s+)(.*)$/);
      const prefixe = prefixMatch ? prefixMatch[1] : "";
      const reste = prefixMatch ? prefixMatch[2] : ligne;
      const m = reste.match(/^(\S+)/);
      if (!m) return ligne;
      const verbe = m[1];
      return `${prefixe}**${verbe.toUpperCase()}**${reste.slice(verbe.length)}`;
    })
    .join("\n");
}

const CIVILITE_LONGUE: Record<string, string> = { "M.": "Monsieur", Mme: "Madame", Mlle: "Mademoiselle" };

// Formule d'appel ("Monsieur," / "Madame," / "Mademoiselle,") deduite de la
// civilite d'un destinataire - jamais figee dans le template, pour ne
// jamais afficher "Monsieur" devant une societe. Repli generique "Madame,
// Monsieur," si la civilite n'est pas precisee (personne morale, ou
// personne physique dont la civilite n'a pas ete choisie).
function civiliteAppel(civilite: string | null | undefined): string {
  return civilite ? `${CIVILITE_LONGUE[civilite]},` : "Madame, Monsieur,";
}

// Decoupe un texte rediage par l'IA en blocs, chacun precede d'un marqueur
// "[[NOM_DU_BLOC]]" sur sa propre ligne (voir CONCLUSIONS_SYSTEM_PROMPT).
// Utilise pour repartir le texte genere entre plusieurs balises d'un
// template Google Docs plutot que de tout mettre dans une seule.
function decouperBlocsMarques(texte: string, marqueurs: string[]): Record<string, string> {
  const resultat: Record<string, string> = {};
  const regex = new RegExp(`\\[\\[(${marqueurs.join("|")})\\]\\]`, "g");
  const parts = texte.split(regex);
  for (let i = 1; i < parts.length; i += 2) {
    resultat[parts[i]] = (parts[i + 1] ?? "").trim();
  }
  return resultat;
}

// Extrait le nom de la partie adverse a partir du formulaire, quand ce type
// de document en a une (utilise pour distinguer le nom du document genere -
// voir computeNomDocument) - renvoie null pour les types sans partie
// adverse nommee (ex: requete, ou un simple destinataire de civilite).
function nomAdversePourForm(form: WebActionForm): string | null {
  switch (form.type_action) {
    case "assignation":
    case "mise_en_demeure":
      return form.destinataire || null;
    case "plainte":
    case "requete":
    case "projet_ordonnance":
      return form.nom_defendeur || null;
    case "conclusions":
    case "note_plaidoirie":
      return form.nom_partie_adverse || null;
    default:
      return null;
  }
}

export type DossierLookupResult =
  | { ok: true; dossier: Awaited<ReturnType<typeof prisma.dossier.findFirstOrThrow>> }
  | { ok: false; error: string };

// Utilise pour redac/conclusions/assignation/mise_en_demeure/requete : si le
// dossier existe deja on le reutilise tel quel, sinon on le cree a la volee
// (utile pour une nouvelle affaire qui commence directement par une
// assignation ou une mise en demeure, sans compte-rendu d'audience
// prealable) - mais il faut alors le nom du client, jamais devine.
//
// Pour les types ou le numero de dossier est facultatif (plaidoirie,
// conclusions, requete "rapides", sans suivi de dossier precis) : les
// documents generes sans numero sont regroupes dans un dossier partage
// "SANS-NUMERO" par cabinet (meme convention que le canal WhatsApp), cree
// automatiquement au premier usage plutot que de bloquer la generation.
export async function findOrCreateDossier(facts: {
  cabinetId: string;
  userId: string;
  numeroDossier?: string;
  nomAffaire?: string;
  nomClient?: string;
}): Promise<DossierLookupResult> {
  const numeroDossierFourni = !!facts.numeroDossier?.trim();

  if (numeroDossierFourni) {
    const numeroDossier = facts.numeroDossier!.trim();
    const existing = await prisma.dossier.findFirst({
      where: { cabinetId: facts.cabinetId, numeroDossier },
    });
    if (existing) return { ok: true, dossier: existing };

    if (!facts.nomClient) {
      return {
        ok: false,
        error:
          "Dossier introuvable pour ce numéro. Pour créer un nouveau dossier, renseigne aussi le nom du client.",
      };
    }
    const dossier = await prisma.dossier.create({
      data: {
        cabinetId: facts.cabinetId,
        numeroDossier,
        nomAffaire: facts.nomAffaire?.trim() || "Document sans dossier",
        nomClient: facts.nomClient,
        createdBy: facts.userId,
      },
    });
    return { ok: true, dossier };
  }

  // Aucun numero fourni : on ne regroupe plus systematiquement dans un seul
  // dossier "SANS-NUMERO" partage par tout le cabinet (ce qui melangeait des
  // affaires differentes des qu'un premier dossier sans numero existait deja) -
  // on cherche un dossier "sans numero" non archive portant le meme nom
  // d'affaire et de client, et on n'en cree un nouveau que si aucun ne
  // correspond.
  const nomClient = facts.nomClient || "Non précisé";
  const nomAffaire = facts.nomAffaire?.trim() || "Document sans dossier";

  const existingSansNumero = await prisma.dossier.findFirst({
    where: {
      cabinetId: facts.cabinetId,
      numeroDossier: { startsWith: "SANS-NUMERO" },
      nomClient,
      nomAffaire,
      archivedAt: null,
    },
  });
  if (existingSansNumero) return { ok: true, dossier: existingSansNumero };

  const numeroDossier = `SANS-NUMERO-${Date.now().toString(36).toUpperCase()}`;
  const dossier = await prisma.dossier.create({
    data: {
      cabinetId: facts.cabinetId,
      numeroDossier,
      nomAffaire,
      nomClient,
      createdBy: facts.userId,
    },
  });
  return { ok: true, dossier };
}

// Genre grammatical des juridictions beninoises proposees dans le
// formulaire de plainte, pour composer une adresse correcte selon la
// civilite choisie ("du/de la Cour..." ou "pres le/la ..." pour un
// procureur). Ne couvre que les valeurs de la liste deroulante du formulaire.
const JURIDICTIONS_BENIN_GENRE: Record<string, { article: string; possessif: string }> = {
  "Tribunal de Première Instance": { article: "le", possessif: "du" },
  "Tribunal de commerce": { article: "le", possessif: "du" },
  "Tribunal de Conciliation": { article: "le", possessif: "du" },
  "Cour d'appel": { article: "la", possessif: "de la" },
  "Cour de Répression des Infractions Économiques et du Terrorisme": {
    article: "la",
    possessif: "de la",
  },
  "Cour Suprême du Bénin": { article: "la", possessif: "de la" },
  "Cour Constitutionnelle du Bénin": { article: "la", possessif: "de la" },
  "Haute Cour de Justice": { article: "la", possessif: "de la" },
  "Cour de Cassation": { article: "la", possessif: "de la" },
};

// Compose l'adresse du destinataire d'un courrier (plainte, requete,
// plaidoirie/conclusions adressees a un juge ou a la partie adverse) a
// partir de champs facultatifs et independants (civilite, juridiction,
// ville, nom de l'avocat) saisis via des listes deroulantes - jamais
// devine, uniquement assemble a partir de ce qui est fourni.
function composeDestinataire(
  civilite?: string,
  juridiction?: string,
  ville?: string,
  nomAvocat?: string
): string | undefined {
  if (!civilite) return undefined;

  // Cas particulier : la partie adverse est un confrere, pas une
  // juridiction - pas d'accord "du/de la [juridiction]" a faire.
  if (civilite.trim() === "Maître") {
    return nomAvocat ? `Maître ${nomAvocat}` : "Maître";
  }

  if (!juridiction) return ville ? `${civilite} de ${ville}` : civilite;

  const genre = JURIDICTIONS_BENIN_GENRE[juridiction];
  const connecteur = civilite.trim().endsWith("près") ? genre?.article ?? "le" : genre?.possessif ?? "du";
  return `${civilite} ${connecteur} ${juridiction}${ville ? ` de ${ville}` : ""}`;
}

/**
 * getLlmProvider() leve une MissingConfigurationError (cle API du
 * fournisseur actif absente) de facon synchrone, AVANT tout traitement -
 * jamais rattrapee automatiquement par Express (pas de gestion native des
 * rejets de promesse d'un handler async en Express 4), donc chaque route
 * qui l'appelle doit le faire via ce wrapper plutot que directement.
 * Renvoie null (et a deja envoye la reponse 503) en cas de configuration
 * manquante ; propage toute autre erreur (vraiment inattendue, jamais
 * documentee comme degradation attendue).
 */
function getLlmProviderSafe(res: Response): LlmProvider | null {
  try {
    return getLlmProvider();
  } catch (error) {
    if (isMissingConfigurationError(error)) {
      console.error("[llm] fournisseur IA non configure :", error.message);
      res.status(503).json({
        error: "La génération de documents par IA n'est pas configurée sur ce poste (clé API manquante). Contactez le support AzoMedIA.",
      });
      return null;
    }
    throw error;
  }
}

const suggererStrategieSchema = z.object({
  nom_affaire: z.string().min(1),
  rappel_procedure: z.string().optional(),
  deroulement_debats: z.string().min(1),
  decision: z.string().min(1),
});

// Bouton "Laisser l'IA proposer un brouillon" sur le champ "Strategie et
// suite a donner" du compte-rendu d'audience - renvoie une simple
// proposition texte, jamais integree automatiquement : l'avocat la relit,
// la corrige et la colle lui-meme dans le formulaire avant generation.
webActionsRouter.post(
  "/api/actions/notes/suggerer-strategie",
  requireAuth,
  aiActionsLimiter,
  async (req, res) => {
    const parsed = suggererStrategieSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
    }
    const llm = getLlmProviderSafe(res);
    if (!llm) return;
    try {
      const suggestion = await llm.redact(
        NOTES_STRATEGIE_SUGGESTION_SYSTEM_PROMPT,
        buildNotesStrategieSuggestionUserPrompt({
          nomAffaire: parsed.data.nom_affaire,
          rappelProcedure: parsed.data.rappel_procedure,
          deroulementDebats: parsed.data.deroulement_debats,
          decision: parsed.data.decision,
        })
      );
      return res.json({ suggestion });
    } catch (error) {
      console.error("Erreur suggestion de strategie :", error);
      return res.status(502).json({ error: "Échec de la suggestion IA, réessaie dans un instant" });
    }
  }
);

webActionsRouter.post("/api/actions/web", requireAuth, requireModule("nouvelle_action"), aiActionsLimiter, async (req, res) => {
  const parsed = webActionFormSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const form = parsed.data;
  const { auth } = req;
  const llm = getLlmProviderSafe(res);
  if (!llm) return;

  const debutMois = new Date();
  debutMois.setDate(1);
  debutMois.setHours(0, 0, 0, 0);

  // Quota mensuel optionnel pour les collaborateurs, fixe par l'admin du
  // cabinet dans Parametres (protection contre les abus de generation -
  // chaque document genere par IA a un cout). Jamais applique aux
  // avocats/titulaire.
  if (auth!.role === "collaborateur") {
    const cabinet = await prisma.cabinet.findUnique({
      where: { id: auth!.cabinetId },
      select: { limiteDocumentsCollaborateurParMois: true },
    });
    const limite = cabinet?.limiteDocumentsCollaborateurParMois;
    if (limite) {
      const count = await prisma.action.count({
        where: { createdBy: auth!.userId, createdAt: { gte: debutMois } },
      });
      if (count >= limite) {
        return res.status(429).json({
          error: `Limite de ${limite} documents générés ce mois-ci atteinte. Contacte ton avocat responsable si tu as besoin d'en générer davantage.`,
        });
      }
    }
  }

  // Quotas mensuels fixes par la PLATEFORME (distincts du quota interne
  // ci-dessus) : un plafond par compte et/ou un plafond global pour tout
  // le cabinet, tous roles confondus - selon la formule souscrite.
  const [cabinetPourQuota, userPourQuota] = await Promise.all([
    prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { limiteDocumentsCabinetParMois: true } }),
    prisma.user.findUnique({ where: { id: auth!.userId }, select: { limiteDocumentsParMois: true } }),
  ]);

  if (userPourQuota?.limiteDocumentsParMois) {
    const count = await prisma.action.count({ where: { createdBy: auth!.userId, createdAt: { gte: debutMois } } });
    if (count >= userPourQuota.limiteDocumentsParMois) {
      return res.status(429).json({
        error: `Limite de ${userPourQuota.limiteDocumentsParMois} documents générés ce mois-ci atteinte pour ce compte. Contactez l'administrateur de la plateforme.`,
      });
    }
  }

  if (cabinetPourQuota?.limiteDocumentsCabinetParMois) {
    const count = await prisma.action.count({
      where: { dossier: { cabinetId: auth!.cabinetId }, createdAt: { gte: debutMois } },
    });
    if (count >= cabinetPourQuota.limiteDocumentsCabinetParMois) {
      return res.status(429).json({
        error: `Limite de ${cabinetPourQuota.limiteDocumentsCabinetParMois} documents générés ce mois-ci atteinte pour le cabinet. Contactez l'administrateur de la plateforme.`,
      });
    }
  }

  try {
    let dossierId: string;
    let action: ActionOutput;
    // Champs additionnels specifiques a certains types d'actes (ex: nom du
    // defendeur et juridiction pour une assignation), en plus du contenu
    // ActionOutput standard - persistes sur Action.champsDocument pour que
    // les exports Word/PDF locaux reconstruisent le formalisme complet
    // (voir documentFormalisme.ts).
    let extraWebhookFields: Record<string, unknown> = {};
    // Lot 5 : true seulement si la branche empruntee ci-dessous a
    // effectivement tokenise au moins une donnee identifiante avant l'appel
    // LLM (voir security/anonymizer.ts) - reste false uniquement pour les
    // types sans aucun champ identifiant a proteger (recherches/
    // traductions/veilles, qui ne portent jamais de nom de client/partie).
    // Tout type qui manipule un nom de client/partie adverse/destinataire
    // doit passer par redigerAvecPseudonymisation, sans exception.
    let donneesPseudonymisees = false;

    if (form.type_action === "notes") {
      // Lot 5 : nomJuge/nomGreffier/nomPartieAdverse et le nom du client
      // sont les seuls champs identifiants envoyes au LLM pour ce type
      // d'acte (voir README-LOT5.md) - jamais le contexte narratif
      // (rappelProcedure/deroulementDebats/decision), qui n'est pas
      // tokenise (pas de detection heuristique dans du texte libre).
      const champsIdentifiantsNotes: ChampIdentifiantInput[] = [
        { champ: "nomClient", role: "PARTIE", valeur: form.nom_client },
        { champ: "nomPartieAdverse", role: "PARTIE", valeur: form.nom_partie_adverse },
        { champ: "nomJuge", role: "JUGE", valeur: form.nom_juge },
        { champ: "nomGreffier", role: "GREFFIER", valeur: form.nom_greffier },
      ];
      const { texteFinal: redigé, donneesPseudonymisees: dpNotes } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsNotes,
        promptTexte: buildNotesUserPrompt({
          numeroDossier: form.numero_dossier,
          nomAffaire: form.nom_affaire,
          nomClient: form.nom_client,
          nomJuridiction: form.nom_juridiction,
          nomChambre: form.nom_chambre,
          numeroRg: form.numero_rg,
          objetLitige: form.objet_litige,
          nomJuge: form.nom_juge,
          nomGreffier: form.nom_greffier,
          nomPartieAdverse: form.nom_partie_adverse,
          rappelProcedure: form.rappel_procedure,
          deroulementDebats: form.deroulement_debats,
          decision: form.decision,
          strategieSuite: form.strategie_suite,
          prochaineAudience: form.prochaine_audience,
          piecesPrevoir: form.pieces_prevoir,
        }),
        redact: (p) => llm.redact(NOTES_SYSTEM_PROMPT, p),
        typeActionLog: "notes",
      });
      donneesPseudonymisees = dpNotes;

      const dossier = await prisma.dossier.upsert({
        where: {
          cabinetId_numeroDossier: { cabinetId: auth!.cabinetId, numeroDossier: form.numero_dossier },
        },
        update: {
          nomAffaire: form.nom_affaire,
          nomClient: form.nom_client,
          nomJuridiction: form.nom_juridiction,
          nomChambre: form.nom_chambre,
        },
        create: {
          cabinetId: auth!.cabinetId,
          numeroDossier: form.numero_dossier,
          nomAffaire: form.nom_affaire,
          nomClient: form.nom_client,
          nomJuridiction: form.nom_juridiction,
          nomChambre: form.nom_chambre,
          createdBy: auth!.userId,
        },
      });
      dossierId = dossier.id;

      const blocsNotes = decouperBlocsMarques(redigé, ["RAPPEL_PROCEDURE", "DEROULEMENT_DEBATS", "DECISION"]);
      const rappelProcedureRedige = blocsNotes.RAPPEL_PROCEDURE ?? "";
      const deroulementDebatsRedige = blocsNotes.DEROULEMENT_DEBATS ?? "";
      const decisionRedigee = blocsNotes.DECISION ?? "";

      const cabinetPourAdresseNotes = await prisma.cabinet.findUnique({
        where: { id: auth!.cabinetId },
        select: { nom: true, adresse: true },
      });

      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees) - la
      // "Strategie et suite a donner" n'est jamais reformulee par l'IA,
      // reprise telle quelle du formulaire (voir note plus haut).
      const syntheseComplete = [
        rappelProcedureRedige ? ["I. RAPPEL DE LA PROCÉDURE", rappelProcedureRedige].join("\n\n") : "",
        ["II. DÉROULEMENT DES DÉBATS ET PLAIDOIRIES", deroulementDebatsRedige].join("\n\n"),
        ["III. DÉCISION DU TRIBUNAL", decisionRedigee].join("\n\n"),
        form.strategie_suite ? ["IV. STRATÉGIE ET SUITE À DONNER", form.strategie_suite].join("\n\n") : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      extraWebhookFields = {
        numero_rg: form.numero_rg ?? null,
        objet_litige: form.objet_litige ?? null,
        nom_juge: form.nom_juge ?? null,
        nom_greffier: form.nom_greffier ?? null,
        nom_partie_adverse: form.nom_partie_adverse ?? null,
        nom_avocat: form.nom_avocat ?? null,
        nom_cabinet: cabinetPourAdresseNotes?.nom || null,
        adresse_cabinet: cabinetPourAdresseNotes?.adresse || form.adresse_cabinet_manuel || null,
        ville: form.ville ?? null,
        nom_juridiction: form.nom_juridiction ?? null,
        nom_chambre: form.nom_chambre ?? null,
        rappel_procedure: rappelProcedureRedige,
        deroulement_debats: deroulementDebatsRedige,
        strategie_suite: form.strategie_suite ?? null,
      };

      action = {
        type_action: "notes",
        categorie_texte: "Compte-rendu d'audience",
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
        nom_client: form.nom_client,
        nom_juridiction: form.nom_juridiction ?? null,
        nom_chambre: form.nom_chambre ?? null,
        date_audience: form.date_audience,
        decision: decisionRedigee,
        prochaine_audience: form.prochaine_audience ?? null,
        pieces_prevoir: form.pieces_prevoir?.join(", ") ?? null,
        synthese: syntheseComplete,
        argumentaire: null,
      };
    } else if (form.type_action === "redac") {
      const config = TEXTE_JURIDIQUE_CONFIG.redac;
      // Pas de destinataire pour la plaidoirie : c'est le discours que
      // l'avocat prononce lui-meme a l'audience, jamais une lettre adressee
      // a quelqu'un d'autre.
      const champsIdentifiantsRedac: ChampIdentifiantInput[] = [
        { champ: "nomClient", role: "PARTIE", valeur: form.nom_client },
      ];
      const { texteFinal: redigé, donneesPseudonymisees: dpRedac } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsRedac,
        promptTexte: buildRedacUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          nomClient: form.nom_client,
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
        }),
        redact: (p) => llm.redact(config.systemPrompt, p),
        typeActionLog: "redac",
      });
      donneesPseudonymisees = dpRedac;

      const dossierLookup = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookup.ok) {
        return res.status(404).json({ error: dossierLookup.error });
      }
      const dossier = dossierLookup.dossier;
      dossierId = dossier.id;

      action = {
        type_action: "redac",
        categorie_texte: config.categorieTexte,
        numero_dossier: dossier.numeroDossier,
        nom_affaire: dossier.nomAffaire,
        nom_client: null,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "assignation") {
      const champsIdentifiantsAssignation: ChampIdentifiantInput[] = [
        { champ: "nomClient", role: "PARTIE", valeur: form.nom_client },
        { champ: "nomDefendeur", role: "PARTIE", valeur: form.destinataire },
      ];
      const { texteFinal: redigeBrut, donneesPseudonymisees: dpAssignation } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsAssignation,
        promptTexte: buildAssignationUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          nomClient: form.nom_client,
          nomDefendeur: form.destinataire,
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          demandeClient: form.demande_client,
          fondementJuridique: form.fondement_juridique,
          qualificationJuridique: form.qualification_juridique,
          prejudiceSubi: form.prejudice_subi,
        }),
        redact: (p) => llm.redact(ASSIGNATION_SYSTEM_PROMPT, p),
        typeActionLog: "assignation",
      });
      donneesPseudonymisees = dpAssignation;

      const blocs = decouperBlocsMarques(redigeBrut, [
        "DEMANDE_CLIENT",
        "EXPOSE_DES_FAITS",
        "FONDEMENT_JURIDIQUE",
        "QUALIFICATION_JURIDIQUE",
        "PREJUDICE_SUBI",
      ]);
      const demandeClient = blocs.DEMANDE_CLIENT ?? "";
      const exposeDesFaitsAssignation = blocs.EXPOSE_DES_FAITS ?? "";
      const fondementJuridiqueAssignation = blocs.FONDEMENT_JURIDIQUE ?? "";
      const qualificationJuridiqueAssignation = blocs.QUALIFICATION_JURIDIQUE ?? "";
      const prejudiceSubiAssignation = blocs.PREJUDICE_SUBI ?? "";
      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees). Le paragraphe
      // "PAR CES MOTIFS" (Il plaise au Tribunal... DÉCLARER... CONSTATER...)
      // est une formule fixe du formalisme d'assignation, verifiee identique
      // sur deux documents reels distincts issus du pipeline Google Docs -
      // jamais generee par l'IA, jamais saisie par l'avocat.
      const demandesAssignation = majusculerPremierVerbe(form.demandes.map((d) => `- ${d}`).join("\n"));
      const redigé = [
        ["I. OBJET DE LA DEMANDE", demandeClient].filter(Boolean).join("\n\n"),
        ["II. EXPOSÉ DES FAITS", exposeDesFaitsAssignation].filter(Boolean).join("\n\n"),
        ["III. DISCUSSION JURIDIQUE", fondementJuridiqueAssignation, qualificationJuridiqueAssignation, prejudiceSubiAssignation]
          .filter(Boolean)
          .join("\n\n"),
        [
          "PAR CES MOTIFS",
          `Il plaise au ${form.nom_juridiction || "Tribunal de Première Instance"} de ${form.ville || "Cotonou"} de :`,
          `- **DÉCLARER** **${form.nom_client}** recevable et bien fondé en son action.`,
          `- **CONSTATER** le non-respect par **${form.destinataire}** de ses engagements contractuels.`,
        ].join("\n\n"),
        ["**En conséquence :**", demandesAssignation].join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

      const dossierLookupAssignation = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookupAssignation.ok) {
        return res.status(404).json({ error: dossierLookupAssignation.error });
      }
      const dossierAssignation = dossierLookupAssignation.dossier;
      dossierId = dossierAssignation.id;

      const [cabinetPourAdresseAssignation, clientPourInfosAssignation] = await Promise.all([
        prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { nom: true, adresse: true } }),
        dossierAssignation.clientId
          ? prisma.client.findUnique({
              where: { id: dossierAssignation.clientId },
              select: {
                civilite: true,
                dateNaissance: true,
                lieuNaissance: true,
                numeroPieceIdentite: true,
                situationMatrimoniale: true,
                quartierResidence: true,
                rue: true,
                maison: true,
                autrePrecision: true,
              },
            })
          : Promise.resolve(null),
      ]);

      const civiliteClientAssignation = clientPourInfosAssignation?.civilite || form.civilite_client_manuel || null;
      const informationsClientAssignation =
        composerInformationsClientAssignation(clientPourInfosAssignation) || form.informations_client || null;
      const adresseClientAssignation =
        composerAdresseClient(clientPourInfosAssignation) || form.adresse_client_manuel || null;
      const adresseCabinetAssignation = cabinetPourAdresseAssignation?.adresse || form.adresse_cabinet_manuel || null;

      extraWebhookFields = {
        demande_client: demandeClient,
        expose_des_faits: exposeDesFaitsAssignation,
        fondement_juridique: fondementJuridiqueAssignation,
        qualification_juridique: qualificationJuridiqueAssignation,
        prejudice_subi: prejudiceSubiAssignation,
        demandes: demandesAssignation,
        nom_defendeur: form.destinataire,
        nom_avocat: form.nom_avocat,
        nom_huissier: form.nom_huissier,
        nom_juridiction: form.nom_juridiction,
        nom_chambre: form.nom_chambre ?? null,
        ville: form.ville,
        profession_client: form.profession_client ?? null,
        civilite_client: civiliteClientAssignation,
        civilite_nom_client: assemblerCivilite(civiliteClientAssignation, dossierAssignation.nomClient),
        informations_client: informationsClientAssignation,
        nationalite_client: form.nationalite_client ?? null,
        adresse_client: adresseClientAssignation,
        adresse_cabinet: adresseCabinetAssignation,
        nom_cabinet: cabinetPourAdresseAssignation?.nom || null,
      };

      action = {
        type_action: "assignation",
        categorie_texte: "Assignation",
        numero_dossier: dossierAssignation.numeroDossier,
        nom_affaire: dossierAssignation.nomAffaire,
        nom_client: dossierAssignation.nomClient,
        nom_juridiction: form.nom_juridiction,
        nom_chambre: form.nom_chambre ?? null,
        date_audience: form.date_audience ?? null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "conclusions") {
      const champsIdentifiantsConclusions: ChampIdentifiantInput[] = [
        { champ: "nomClient", role: "PARTIE", valeur: form.nom_client },
        { champ: "nomPartieAdverse", role: "PARTIE", valeur: form.nom_partie_adverse },
      ];
      const { texteFinal: redigeBrut, donneesPseudonymisees: dpConclusions } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsConclusions,
        promptTexte: buildConclusionsUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          nomClient: form.nom_client,
          nomPartieAdverse: form.nom_partie_adverse,
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          fondementJuridique: form.fondement_juridique,
          qualificationJuridique: form.qualification_juridique,
          prejudiceSubi: form.prejudice_subi,
          reparationDemandee: form.reparation_demandee,
          montantFraisProcedure: form.montant_frais_procedure,
          manquementAFaireJuger: form.manquement_a_faire_juger,
          demanderDepens: form.demander_depens,
        }),
        redact: (p) => llm.redact(CONCLUSIONS_SYSTEM_PROMPT, p),
        typeActionLog: "conclusions",
      });
      donneesPseudonymisees = dpConclusions;

      const blocs = decouperBlocsMarques(redigeBrut, [
        "EXPOSE_DES_FAITS",
        "FONDEMENT_JURIDIQUE",
        "QUALIFICATION_JURIDIQUE",
        "PREJUDICE_SUBI",
        "REPARATION_DEMANDEE",
        "FRAIS_PROCEDURE",
        "MANQUEMENT_A_JUGER",
        "CONDAMNATION_DEMANDEE",
      ]);
      const exposeDesFaits = blocs.EXPOSE_DES_FAITS ?? "";
      const fondementJuridique = blocs.FONDEMENT_JURIDIQUE ?? "";
      const qualificationJuridique = blocs.QUALIFICATION_JURIDIQUE ?? "";
      const prejudiceSubi = blocs.PREJUDICE_SUBI ?? "";
      const reparationDemandee = blocs.REPARATION_DEMANDEE ?? "";
      const fraisProcedure = blocs.FRAIS_PROCEDURE ?? "";
      const manquementAJuger = blocs.MANQUEMENT_A_JUGER ?? "";
      const condamnationDemandee = blocs.CONDAMNATION_DEMANDEE ?? "";
      const dossierLookup = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookup.ok) {
        return res.status(404).json({ error: dossierLookup.error });
      }
      const dossier = dossierLookup.dossier;
      dossierId = dossier.id;

      const [cabinetPourAdresse, auteur, clientPourInfos] = await Promise.all([
        prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { nom: true, adresse: true } }),
        prisma.user.findUnique({ where: { id: auth!.userId }, select: { nom: true } }),
        dossier.clientId
          ? prisma.client.findUnique({
              where: { id: dossier.clientId },
              select: { dateNaissance: true, lieuNaissance: true, quartierResidence: true, rue: true, maison: true, autrePrecision: true },
            })
          : Promise.resolve(null),
      ]);

      // Base d'abord (fiche client / paramètres du cabinet), champ de secours
      // du formulaire seulement si l'info n'y est pas disponible.
      const informationsClient = composerInformationsClient(clientPourInfos) || form.informations_client || null;
      const adresseCabinet = cabinetPourAdresse?.adresse || form.adresse_cabinet_manuel || null;

      // Bordereau des pieces jointes : une liste numerotee, construite ici
      // (jamais par l'IA) pour etre fidele a 100% a ce que l'avocat a saisi.
      const bordereauPieces =
        form.pieces && form.pieces.length > 0
          ? form.pieces.map((p, i) => `${i + 1}. ${p}`).join("\n")
          : "Aucune pièce communiquée à ce stade.";

      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees). "III.
      // DISPOSITIF" / "PAR CES MOTIFS" / "VU les pièces versées aux
      // débats ;" / "DÉCLARER... DÉBOUTER..." sont des formules fixes du
      // formalisme des Conclusions, verifiees sur un document reel fourni
      // par l'utilisateur - jamais generees par l'IA, jamais saisies par
      // l'avocat.
      const redigé = [
        ["**1. EXPOSÉ DES FAITS ET DE LA PROCÉDURE**", exposeDesFaits].filter(Boolean).join("\n\n"),
        espace(),
        [
          "**2. DISCUSSION JURIDIQUE**",
          fondementJuridique,
          qualificationJuridique,
          prejudiceSubi,
          reparationDemandee,
          fraisProcedure,
        ]
          .filter(Boolean)
          .join("\n\n"),
        espace(),
        [
          "**III. DISPOSITIF (Le « Par ces motifs »)**",
          "PAR CES MOTIFS",
          form.nom_juridiction && `${form.nom_juridiction} est invité à :`,
          "VU les pièces versées aux débats ;",
          `**DÉCLARER** **${dossier.nomClient}** recevable et bien fondé en ses demandes, fins et conclusions.`,
          form.nom_partie_adverse &&
            `**DÉBOUTER** **${form.nom_partie_adverse}** de l'ensemble de ses demandes, fins, conclusions et prétentions contraires.`,
          "**En conséquence :**",
          mettreEnGrasVerbeInitial(manquementAJuger),
          mettreEnGrasVerbeInitial(condamnationDemandee),
        ]
          .filter(Boolean)
          .join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

      extraWebhookFields = {
        expose_des_faits: exposeDesFaits,
        fondement_juridique: fondementJuridique,
        qualification_juridique: qualificationJuridique,
        prejudice_subi: prejudiceSubi,
        reparation_demandee: reparationDemandee,
        montant_frais_procedure: fraisProcedure,
        manquement_a_faire_juger: manquementAJuger,
        condamnation_demandee: condamnationDemandee,
        qualite_client: form.qualite_client ?? null,
        informations_client: informationsClient,
        nationalite_client: form.nationalite_client ?? null,
        nom_partie_adverse: form.nom_partie_adverse ?? null,
        informations_partie_adverse: form.informations_partie_adverse ?? null,
        qualite_partie_adverse: form.qualite_partie_adverse ?? null,
        nationalite_partie_adverse: form.nationalite_partie_adverse ?? null,
        adresse_cabinet: adresseCabinet,
        nom_cabinet: cabinetPourAdresse?.nom || null,
        // L'avocat peut corriger/preciser le nom affiche ; sinon on retombe
        // sur celui du compte qui genere le document.
        nom_avocat: form.nom_avocat || auteur?.nom || null,
        ville: form.ville ?? null,
        nom_juridiction: form.nom_juridiction ?? null,
        destinataire:
          composeDestinataire(form.destinataire, form.nom_juridiction, form.ville, form.nom_avocat_destinataire) ??
          null,
        piece_a_prevoir: bordereauPieces,
      };

      action = {
        type_action: "conclusions",
        categorie_texte: "Conclusions",
        numero_dossier: dossier.numeroDossier,
        nom_affaire: dossier.nomAffaire,
        nom_client: dossier.nomClient,
        nom_juridiction: form.nom_juridiction ?? null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "note_plaidoirie") {
      const champsIdentifiantsNotePlaidoirie: ChampIdentifiantInput[] = [
        { champ: "nomClient", role: "PARTIE", valeur: form.nom_client },
        { champ: "nomPartieAdverse", role: "PARTIE", valeur: form.nom_partie_adverse },
      ];
      const { texteFinal: redigeBrut, donneesPseudonymisees: dpNotePlaidoirie } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsNotePlaidoirie,
        promptTexte: buildNotePlaidoirieUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          nomClient: form.nom_client,
          nomPartieAdverse: form.nom_partie_adverse,
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          fondementJuridique: form.fondement_juridique,
          qualificationJuridique: form.qualification_juridique,
          prejudiceSubi: form.prejudice_subi,
          demandes: form.demandes,
          demanderDepens: form.demander_depens,
        }),
        redact: (p) => llm.redact(NOTE_PLAIDOIRIE_SYSTEM_PROMPT, p),
        typeActionLog: "note_plaidoirie",
      });
      donneesPseudonymisees = dpNotePlaidoirie;

      const blocs = decouperBlocsMarques(redigeBrut, [
        "RAPPEL_FAITS",
        "FONDEMENT_JURIDIQUE",
        "QUALIFICATION_JURIDIQUE",
        "PREJUDICE_SUBI",
        "DEMANDES",
      ]);
      const rappelFaits = blocs.RAPPEL_FAITS ?? "";
      const fondementJuridiqueNote = blocs.FONDEMENT_JURIDIQUE ?? "";
      const qualificationJuridiqueNote = blocs.QUALIFICATION_JURIDIQUE ?? "";
      const prejudiceSubiNote = blocs.PREJUDICE_SUBI ?? "";
      const demandesNote = blocs.DEMANDES ?? "";
      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees). Les sections
      // "I. LES PARTIES" (identite des parties) et le formalisme du
      // dispositif ("PAR CES MOTIFS" / "Il plaira au Tribunal de...")
      // sont geres par documentFormalisme.ts, pas ici.
      const redigé = [
        ["II. RAPPEL DES FAITS", rappelFaits].filter(Boolean).join("\n\n"),
        espace(),
        ["III. DISCUSSION JURIDIQUE", fondementJuridiqueNote, qualificationJuridiqueNote, prejudiceSubiNote]
          .filter(Boolean)
          .join("\n\n"),
        espace(),
        [
          "IV. DISPOSITIF",
          "PAR CES MOTIFS",
          form.nom_juridiction && `**Il plaira au ${form.nom_juridiction} de :**`,
          mettreEnGrasVerbeInitial(demandesNote),
        ]
          .filter(Boolean)
          .join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

      const dossierLookupNote = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookupNote.ok) {
        return res.status(404).json({ error: dossierLookupNote.error });
      }
      const dossierNote = dossierLookupNote.dossier;
      dossierId = dossierNote.id;

      const [cabinetPourAdresseNote, auteurNote, clientPourInfosNote] = await Promise.all([
        prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { nom: true, adresse: true } }),
        prisma.user.findUnique({ where: { id: auth!.userId }, select: { nom: true } }),
        dossierNote.clientId
          ? prisma.client.findUnique({
              where: { id: dossierNote.clientId },
              select: { civilite: true, dateNaissance: true, lieuNaissance: true, quartierResidence: true, rue: true, maison: true, autrePrecision: true },
            })
          : Promise.resolve(null),
      ]);

      const informationsClientNote = composerInformationsClient(clientPourInfosNote) || form.informations_client || null;
      const adresseCabinetNote = cabinetPourAdresseNote?.adresse || form.adresse_cabinet_manuel || null;
      const civiliteClientNote = clientPourInfosNote?.civilite || form.civilite_client_manuel || null;

      extraWebhookFields = {
        rappel_faits: rappelFaits,
        fondement_juridique: fondementJuridiqueNote,
        qualification_juridique: qualificationJuridiqueNote,
        prejudice_subi: prejudiceSubiNote,
        demandes: demandesNote,
        numero_rg: form.numero_rg ?? null,
        qualite_client: form.qualite_client ?? null,
        profession_client: form.profession_client ?? null,
        civilite_client: civiliteClientNote,
        civilite_nom_client: assemblerCivilite(civiliteClientNote, dossierNote.nomClient),
        informations_client: informationsClientNote,
        nom_partie_adverse: form.nom_partie_adverse ?? null,
        qualite_partie_adverse: form.qualite_partie_adverse ?? null,
        profession_partie_adverse: form.profession_partie_adverse ?? null,
        informations_partie_adverse: form.informations_partie_adverse ?? null,
        nom_avocat_partie_adverse: form.nom_avocat_partie_adverse ?? null,
        adresse_cabinet: adresseCabinetNote,
        nom_cabinet: cabinetPourAdresseNote?.nom || null,
        nom_avocat: form.nom_avocat || auteurNote?.nom || null,
        ville: form.ville ?? null,
        destinataire:
          composeDestinataire(form.destinataire, form.nom_juridiction, form.ville, form.nom_avocat_destinataire) ??
          null,
      };

      action = {
        type_action: "note_plaidoirie",
        categorie_texte: "Note de plaidoirie",
        numero_dossier: dossierNote.numeroDossier,
        nom_affaire: dossierNote.nomAffaire,
        nom_client: dossierNote.nomClient,
        nom_juridiction: form.nom_juridiction ?? null,
        nom_chambre: form.nom_chambre ?? null,
        date_audience: form.date_audience ?? null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "mise_en_demeure") {
      // Lot 5 : seul le destinataire (partie adverse) est une donnee
      // identifiante envoyee au LLM pour ce type d'acte.
      const champsIdentifiantsMED: ChampIdentifiantInput[] = [
        { champ: "destinataire", role: "PARTIE", valeur: form.destinataire },
      ];
      const { texteFinal: exposeDesFaitsMED, donneesPseudonymisees: dpMED } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsMED,
        promptTexte: buildMiseEnDemeureUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: form.destinataire,
          contexte: form.contexte,
          dateObligation: form.date_obligation,
          descriptionObligation: form.description_obligation,
          dateEcheancePrevue: form.date_echeance_prevue,
          montantEngage: form.montant_engage,
        }),
        redact: (p) => llm.redact(MISE_EN_DEMEURE_SYSTEM_PROMPT, p),
        typeActionLog: "mise_en_demeure",
      });
      donneesPseudonymisees = dpMED;

      const dossierLookupMED = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookupMED.ok) {
        return res.status(404).json({ error: dossierLookupMED.error });
      }
      const dossierMED = dossierLookupMED.dossier;
      dossierId = dossierMED.id;

      const [cabinetPourAdresseMED, clientPourAdresseMED] = await Promise.all([
        prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { nom: true, adresse: true } }),
        dossierMED.clientId
          ? prisma.client.findUnique({
              where: { id: dossierMED.clientId },
              select: { quartierResidence: true, rue: true, maison: true, autrePrecision: true },
            })
          : Promise.resolve(null),
      ]);

      const adresseClientMED = composerAdresseClient(clientPourAdresseMED) || form.adresse_client_manuel || null;
      const adresseCabinetMED = cabinetPourAdresseMED?.adresse || form.adresse_cabinet_manuel || null;

      const modeNotificationMED =
        form.mode_notification === "lrar"
          ? "LETTRE RECOMMANDÉE AVEC ACCUSÉ DE RÉCEPTION"
          : "PAR EXPLOIT DE COMMISSAIRE DE JUSTICE (HUISSIER)";

      const objetMED = form.objet || `D'EXÉCUTER SES OBLIGATIONS CONTRACTUELLES SOUS ${form.delai_jours} JOURS`;

      const civiliteAppelDestinataireMED = civiliteAppel(form.civilite_destinataire);

      const consequencesMED = form.consequences.map((c, i) => `${i + 1}. ${c}`).join("\n");

      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees).
      const redigéMED = [
        exposeDesFaitsMED,
        `En conséquence, la présente vaut **MISE EN DEMEURE**, formelle et comminatoire, d'avoir à exécuter l'intégralité de vos obligations dans un délai strict de ${form.delai_jours} jours à compter de la notification du présent acte.`,
        `À défaut d'exécution intégrale de vos obligations dans ce délai, ${dossierMED.nomClient} se verra dans l'obligation de saisir la juridiction compétente afin de solliciter :\n${consequencesMED}`,
      ].join("\n\n");

      extraWebhookFields = {
        expose_des_faits: exposeDesFaitsMED,
        mode_notification: modeNotificationMED,
        destinataire: form.destinataire,
        civilite_destinataire: form.civilite_destinataire ?? null,
        civilite_nom_destinataire: assemblerCivilite(form.civilite_destinataire ?? null, form.destinataire),
        civilite_appel_destinataire: civiliteAppelDestinataireMED,
        objet_mise_en_demeure: objetMED,
        // Toujours envoye en texte : l'API Google Docs (replace_all_text)
        // rejette un nombre brut pour une balise de remplacement de texte.
        delai_jours: String(form.delai_jours),
        consequences: consequencesMED,
        nom_avocat: form.nom_avocat ?? null,
        adresse_cabinet: adresseCabinetMED,
        nom_cabinet: cabinetPourAdresseMED?.nom || null,
        adresse_client: adresseClientMED,
        profession_destinataire: form.profession_destinataire ?? null,
        informations_destinataire: form.informations_destinataire ?? null,
      };

      action = {
        type_action: "mise_en_demeure",
        categorie_texte: "Mise en demeure",
        numero_dossier: dossierMED.numeroDossier,
        nom_affaire: dossierMED.nomAffaire,
        nom_client: dossierMED.nomClient,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigéMED,
      };
    } else if (form.type_action === "jurisprudence") {
      // Recherche a plusieurs niveaux : Benin, OHADA/CCJA, France, Afrique
      // francophone elargie, via des appels Tavily paralleles cibles par
      // categorie d'origine (voir services/jurisprudence/rechercheTavily.ts),
      // completes par un appel de secours sans restriction de domaine
      // uniquement si la couverture est insuffisante - toujours effectuee.
      // La base de jurisprudence propre au cabinet n'est incluse en plus
      // que si explicitement cochee.
      const webResults = await rechercherJurisprudenceTavily(form.theme);
      const cabinetMatches = form.inclure_cabinet ? await searchJurisprudence(form.theme) : [];
      // Lot 13 : une seule liste de sources numerotee en continu (cabinet
      // puis web), pour que le marqueur "[REF: Source N]" impose au LLM
      // (voir JURISPRUDENCE_SYSTEM_PROMPT) designe sans ambiguite une seule
      // source precise - jamais deux listes qui redemarreraient chacune a 1.
      const sourcesDisponibles = construireSourcesDisponibles(cabinetMatches, webResults);
      const redigéBrut = await llm.redact(
        JURISPRUDENCE_SYSTEM_PROMPT,
        buildJurisprudenceUserPrompt({
          theme: form.theme,
          juridictions: form.juridictions ?? [],
          sources: formatSourcesPourPrompt(sourcesDisponibles),
        })
      );

      // Lot 13 - grounding strict + liens reels : retire toute citation qui
      // ne correspond a aucune source effectivement recuperee, ou dont le
      // lien est absent/inaccessible ; jamais de blocage de la reponse
      // (voir README-LOT13.md) - seules les citations non verifiees sont
      // retirees, le reste de l'analyse reste affiche normalement.
      const { texte: redigé, sourcesValidees } = await validerEtFiltrerCitations(redigéBrut, sourcesDisponibles);
      // Conserve les sources validees (reference/juridiction/date/lien) pour
      // que le frontend affiche un bloc "Source" distinct du texte d'analyse
      // (objectif 4 du Lot 13) - jamais recalcule a la volee a la relecture,
      // fige au moment de la generation comme le reste de champsDocument.
      if (sourcesValidees.length > 0) {
        extraWebhookFields = { sourcesJurisprudence: sourcesValidees };
      }

      // Recherche de jurisprudence : pas forcement liee a un dossier existant.
      const dossier = await prisma.dossier.upsert({
        where: {
          cabinetId_numeroDossier: { cabinetId: auth!.cabinetId, numeroDossier: `JURIS-${Date.now()}` },
        },
        update: {},
        create: {
          cabinetId: auth!.cabinetId,
          numeroDossier: `JURIS-${Date.now()}`,
          nomAffaire: form.theme,
          nomClient: "Non applicable",
          createdBy: auth!.userId,
          estRecherche: true,
        },
      });
      dossierId = dossier.id;

      action = {
        type_action: "jurisprudence",
        categorie_texte: "Recherche de jurisprudence",
        numero_dossier: null,
        nom_affaire: form.theme,
        nom_client: null,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "recherche_juridique") {
      // Recherche Tavily ciblee par categorie de sources officielles/doctrine
      // (Benin, OHADA, doctrine/droit compare, France - voir
      // services/recherche-juridique/rechercheTavily.ts), completee par un
      // appel de secours sans restriction de domaine uniquement si la
      // couverture est insuffisante.
      const resultats = await rechercherJuridiqueTavily(form.question);
      // Meme liste numerotee [Source N] et meme grounding strict que la
      // Recherche de jurisprudence (Lot 13, construireSourcesDisponibles/
      // validerEtFiltrerCitations, services/jurisprudence/grounding.ts) -
      // aucun chunk RAG cabinet ici (recherche_juridique n'utilise pas le
      // RAG jurisprudence), uniquement les resultats Tavily.
      const sourcesDisponibles = construireSourcesDisponibles([], resultats);
      const redigéBrut = await llm.redact(
        RECHERCHE_JURIDIQUE_SYSTEM_PROMPT,
        buildRechercheJuridiqueUserPrompt({
          question: form.question,
          resultatsRecherche: formatSourcesPourPrompt(sourcesDisponibles),
        })
      );

      const { texte: redigé, sourcesValidees } = await validerEtFiltrerCitations(redigéBrut, sourcesDisponibles);
      if (sourcesValidees.length > 0) {
        extraWebhookFields = { sourcesJurisprudence: sourcesValidees };
      }

      // Recherche juridique : pas forcement liee a un dossier existant.
      const dossier = await prisma.dossier.upsert({
        where: {
          cabinetId_numeroDossier: { cabinetId: auth!.cabinetId, numeroDossier: `RECH-${Date.now()}` },
        },
        update: {},
        create: {
          cabinetId: auth!.cabinetId,
          numeroDossier: `RECH-${Date.now()}`,
          nomAffaire: form.question,
          nomClient: "Non applicable",
          createdBy: auth!.userId,
          estRecherche: true,
        },
      });
      dossierId = dossier.id;

      action = {
        type_action: "recherche_juridique",
        categorie_texte: "Recherche juridique",
        numero_dossier: null,
        nom_affaire: form.question,
        nom_client: null,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "resume_pdf") {
      const base64Data = form.pdfDataUrl.replace(/^data:application\/pdf;base64,/, "");
      const pdfBuffer = Buffer.from(base64Data, "base64");

      let texteExtrait: string;
      try {
        const parsed = await pdfParse(pdfBuffer);
        texteExtrait = parsed.text.trim();
      } catch (error) {
        console.error("Erreur extraction texte PDF :", error);
        return res.status(400).json({ error: "Impossible de lire ce PDF (fichier corrompu ou non supporté)" });
      }

      if (texteExtrait.length === 0) {
        return res
          .status(400)
          .json({ error: "Aucun texte détecté dans ce PDF (peut-être un scan sans OCR)" });
      }

      const redigé = await summarizeLongText(llm, texteExtrait, form.contexte);
      const nomAffaire = form.contexte?.slice(0, 120) || "Résumé de document PDF";

      // Resume PDF : pas forcement lie a un dossier existant.
      const dossier = await prisma.dossier.upsert({
        where: {
          cabinetId_numeroDossier: { cabinetId: auth!.cabinetId, numeroDossier: `RESUME-${Date.now()}` },
        },
        update: {},
        create: {
          cabinetId: auth!.cabinetId,
          numeroDossier: `RESUME-${Date.now()}`,
          nomAffaire,
          nomClient: "Non applicable",
          createdBy: auth!.userId,
          estRecherche: true,
        },
      });
      dossierId = dossier.id;

      action = {
        type_action: "resume_pdf",
        categorie_texte: "Résumé de jurisprudence",
        numero_dossier: null,
        nom_affaire: nomAffaire,
        nom_client: null,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "traduction") {
      let texteSource = form.texte_source?.trim() ?? "";
      if (!texteSource && form.documentDataUrl) {
        try {
          texteSource = await extractTextFromDocument(form.documentDataUrl);
        } catch (error) {
          console.error("Erreur extraction texte document :", error);
          return res
            .status(400)
            .json({ error: "Impossible de lire ce document (fichier corrompu ou non supporté)" });
        }
      }
      if (!texteSource) {
        return res.status(400).json({ error: "Fournis un texte ou un document à traduire" });
      }

      const traduit = await translateText(llm, form.sens, texteSource);
      const nomAffaire = `Traduction ${form.sens === "fr_vers_en" ? "FR → EN" : "EN → FR"}`;

      // Traduction : pas forcement liee a un dossier existant.
      const dossier = await prisma.dossier.upsert({
        where: {
          cabinetId_numeroDossier: { cabinetId: auth!.cabinetId, numeroDossier: `TRAD-${Date.now()}` },
        },
        update: {},
        create: {
          cabinetId: auth!.cabinetId,
          numeroDossier: `TRAD-${Date.now()}`,
          nomAffaire,
          nomClient: "Non applicable",
          createdBy: auth!.userId,
          estRecherche: true,
        },
      });
      dossierId = dossier.id;

      action = {
        type_action: "traduction",
        categorie_texte: "Traduction",
        numero_dossier: null,
        nom_affaire: nomAffaire,
        nom_client: null,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: traduit,
      };
    } else if (form.type_action === "plainte") {
      // Lot 5 : seul le nom du mis en cause (defendeur) est une donnee
      // identifiante envoyee au LLM pour ce type d'acte.
      const champsIdentifiantsPlainte: ChampIdentifiantInput[] = [
        { champ: "nomDefendeur", role: "PARTIE", valeur: form.nom_defendeur },
      ];
      const { texteFinal: redigeBrutPlainte, donneesPseudonymisees: dpPlainte } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsPlainte,
        promptTexte: buildPlainteUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          nomDefendeur: form.nom_defendeur,
          contexte: form.contexte,
          qualificationInfraction: form.qualification_infraction,
          dateFaits: form.date_faits,
          descriptionAccord: form.description_accord,
          montantEngage: form.montant_engage,
          fondementJuridique: form.fondement_juridique,
        }),
        redact: (p) => llm.redact(PLAINTE_SYSTEM_PROMPT, p),
        typeActionLog: "plainte",
      });
      donneesPseudonymisees = dpPlainte;

      const blocsPlainte = decouperBlocsMarques(redigeBrutPlainte, ["EXPOSE_DES_FAITS", "DISCUSSION_JURIDIQUE"]);
      const exposeDesFaitsPlainte = blocsPlainte.EXPOSE_DES_FAITS ?? "";
      const discussionJuridiquePlainte = blocsPlainte.DISCUSSION_JURIDIQUE ?? "";

      const dossierLookupPlainte = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookupPlainte.ok) {
        return res.status(404).json({ error: dossierLookupPlainte.error });
      }
      const dossierPlainte = dossierLookupPlainte.dossier;
      dossierId = dossierPlainte.id;

      const [cabinetPourAdressePlainte, clientPourInfosPlainte] = await Promise.all([
        prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { nom: true, adresse: true } }),
        dossierPlainte.clientId
          ? prisma.client.findUnique({
              where: { id: dossierPlainte.clientId },
              select: {
                civilite: true,
                telephone: true,
                email: true,
                dateNaissance: true,
                lieuNaissance: true,
                numeroPieceIdentite: true,
                situationMatrimoniale: true,
                quartierResidence: true,
                rue: true,
                maison: true,
                autrePrecision: true,
              },
            })
          : Promise.resolve(null),
      ]);

      const civiliteClientPlainte = clientPourInfosPlainte?.civilite || form.civilite_client_manuel || null;
      const informationsClientPlainte =
        composerInformationsClientAssignation(clientPourInfosPlainte) || form.informations_client || null;
      const adresseClientPlainte = composerAdresseClient(clientPourInfosPlainte) || form.adresse_client_manuel || null;
      const adresseCabinetPlainte = cabinetPourAdressePlainte?.adresse || form.adresse_cabinet_manuel || null;
      const telephoneClientPlainte = clientPourInfosPlainte?.telephone || form.telephone_client_manuel || null;
      const emailClientPlainte = clientPourInfosPlainte?.email || form.email_client_manuel || null;

      const demandesPlainte = form.demandes.map((d) => `- ${d}`).join("\n");

      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees). Deux
      // presentations differentes selon mode_redaction (voir
      // documentFormalisme.ts pour le detail complet des deux formalismes,
      // verifies chacun sur un document reel distinct) : le mode "avocat"
      // garde ses titres "I./II." et des demandes non mises en gras : le
      // mode "plaignant" utilise "LES FAITS :"/"FONDEMENTS :" et met en
      // gras le verbe de chaque demande (DILIGENTER, POURSUIVRE...).
      const redigéPlainte =
        form.mode_redaction === "plaignant"
          ? [
              ["LES FAITS :", exposeDesFaitsPlainte].filter(Boolean).join("\n\n"),
              ["FONDEMENTS :", discussionJuridiquePlainte].filter(Boolean).join("\n\n"),
              [
                "PAR CES MOTIFS",
                "Il vous plaise, Monsieur le Procureur de la République, de :",
                mettreEnGrasVerbeInitial(demandesPlainte),
              ]
                .filter(Boolean)
                .join("\n\n"),
            ]
              .filter(Boolean)
              .join("\n\n")
          : [
              ["I. EXPOSÉ DES FAITS", exposeDesFaitsPlainte].filter(Boolean).join("\n\n"),
              ["II. DISCUSSION JURIDIQUE", discussionJuridiquePlainte].filter(Boolean).join("\n\n"),
              [
                "PAR CES MOTIFS",
                "Il vous plaise, Monsieur le Procureur de la République, de :",
                demandesPlainte,
              ]
                .filter(Boolean)
                .join("\n\n"),
            ]
              .filter(Boolean)
              .join("\n\n");

      extraWebhookFields = {
        mode_redaction: form.mode_redaction,
        expose_des_faits: exposeDesFaitsPlainte,
        discussion_juridique: discussionJuridiquePlainte,
        qualification_infraction: form.qualification_infraction ?? null,
        date_faits: form.date_faits ?? null,
        description_accord: form.description_accord ?? null,
        montant_engage: form.montant_engage ?? null,
        demandes: demandesPlainte,
        nom_defendeur: form.nom_defendeur,
        civilite_defendeur: form.civilite_defendeur ?? null,
        civilite_nom_defendeur: assemblerCivilite(form.civilite_defendeur ?? null, form.nom_defendeur),
        profession_defendeur: form.profession_defendeur ?? null,
        adresse_defendeur: form.adresse_defendeur ?? null,
        nationalite_defendeur: form.nationalite_defendeur ?? null,
        profession_client: form.profession_client ?? null,
        civilite_client: civiliteClientPlainte,
        civilite_nom_client: assemblerCivilite(civiliteClientPlainte, dossierPlainte.nomClient),
        informations_client: informationsClientPlainte,
        nationalite_client: form.nationalite_client ?? null,
        adresse_client: adresseClientPlainte,
        telephone_client: telephoneClientPlainte,
        email_client: emailClientPlainte,
        nom_avocat: form.nom_avocat ?? null,
        adresse_cabinet: adresseCabinetPlainte,
        nom_cabinet: cabinetPourAdressePlainte?.nom || null,
        nom_juridiction: form.nom_juridiction ?? null,
        nom_chambre: form.nom_chambre ?? null,
        destinataire: composeDestinataire(form.destinataire, form.nom_juridiction, form.ville) ?? null,
      };

      action = {
        type_action: "plainte",
        categorie_texte: "Plainte",
        numero_dossier: dossierPlainte.numeroDossier,
        nom_affaire: dossierPlainte.nomAffaire,
        nom_client: dossierPlainte.nomClient,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigéPlainte,
      };
    } else if (form.type_action === "contrat") {
      // Lot 5 : les deux parties et leurs informations d'etat civil/RCCM-IFU
      // sont les donnees identifiantes envoyees au LLM pour ce type d'acte.
      const champsIdentifiantsContrat: ChampIdentifiantInput[] = [
        { champ: "partie1", role: "PARTIE", valeur: form.partie_1 },
        { champ: "partie2", role: "PARTIE", valeur: form.partie_2 },
        { champ: "informationsPartie1", role: "IDENTIFIANT", valeur: form.informations_partie_1 },
        { champ: "informationsPartie2", role: "IDENTIFIANT", valeur: form.informations_partie_2 },
      ];
      const { texteFinal: redigeBrutContrat, donneesPseudonymisees: dpContrat } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsContrat,
        promptTexte: buildContratUserPrompt({
          typeContrat: form.type_contrat ?? "non précisé",
          contexte: form.contexte,
          partie1: form.partie_1 ?? "non précisé",
          typePartie1: form.type_partie_1,
          informationsPartie1: form.informations_partie_1,
          partie2: form.partie_2 ?? "non précisé",
          typePartie2: form.type_partie_2,
          informationsPartie2: form.informations_partie_2,
          objet: form.objet ?? "non précisé",
          obligations: form.obligations ?? "non précisé",
          duree: form.duree,
          conditionsRenouvellement: form.conditions_renouvellement,
          remuneration: form.remuneration,
          modalitesPaiement: form.modalites_paiement,
          dateEffet: form.date_effet,
          conditionsResiliation: form.conditions_resiliation,
          juridictionCompetente: form.juridiction_competente,
          clausesParticulieres: form.clauses_particulieres,
          estAvenant: form.est_avenant ?? false,
          referenceContratInitial: form.reference_contrat_initial,
          objetAvenant: form.objet_avenant,
        }),
        redact: (p) => llm.redact(CONTRAT_SYSTEM_PROMPT, p),
        typeActionLog: "contrat",
      });
      donneesPseudonymisees = dpContrat;

      const redigé =
        form.clause_force_majeure && !form.est_avenant
          ? [redigeBrutContrat, CLAUSE_FORCE_MAJEURE].join("\n\n")
          : redigeBrutContrat;

      const dossierLookup = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookup.ok) {
        return res.status(404).json({ error: dossierLookup.error });
      }
      dossierId = dossierLookup.dossier.id;

      const cabinetPourAdresseContrat = await prisma.cabinet.findUnique({
        where: { id: auth!.cabinetId },
        select: { nom: true, adresse: true },
      });

      extraWebhookFields = {
        type_contrat: form.type_contrat ?? null,
        partie_1: form.partie_1 ?? null,
        informations_partie_1: form.informations_partie_1 ?? null,
        nationalite_partie_1: form.nationalite_partie_1 ?? null,
        partie_2: form.partie_2 ?? null,
        informations_partie_2: form.informations_partie_2 ?? null,
        nationalite_partie_2: form.nationalite_partie_2 ?? null,
        nom_cabinet: cabinetPourAdresseContrat?.nom || null,
        adresse_cabinet: cabinetPourAdresseContrat?.adresse || form.adresse_cabinet_manuel || null,
      };

      action = {
        type_action: "contrat",
        categorie_texte: form.est_avenant ? "Avenant au contrat" : "Contrat",
        numero_dossier: dossierLookup.dossier.numeroDossier,
        nom_affaire: dossierLookup.dossier.nomAffaire,
        nom_client: dossierLookup.dossier.nomClient,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "notification_date") {
      const OBJETS_PAR_DEFAUT: Record<string, string> = {
        date: "NOTIFICATION DE DATE",
        rupture_contrat: `NOTIFICATION FORMELLE DE RUPTURE DU CONTRAT DE ${form.type_contrat_concerne || ""}`.trim(),
        autre: "NOTIFICATION",
      };
      const objetNotif = form.objet || OBJETS_PAR_DEFAUT[form.type_notification];

      // Lot 5 : seul le destinataire est une donnee identifiante envoyee au
      // LLM pour ce type d'acte.
      const champsIdentifiantsNotif: ChampIdentifiantInput[] = [
        { champ: "destinataire", role: "PARTIE", valeur: form.destinataire },
      ];
      const { texteFinal: redigé, donneesPseudonymisees: dpNotif } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsNotif,
        promptTexte: buildNotificationDateUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          destinataire: form.destinataire,
          objet: objetNotif,
          dateNotifiee: form.date_notifiee,
          lieu: form.lieu,
          juridiction: form.nom_juridiction,
          typeContratConcerne: form.type_contrat_concerne,
          dateSignatureContrat: form.date_signature_contrat,
          articleResiliation: form.article_resiliation,
          dureePreavis: form.duree_preavis,
          modeRupture: form.mode_rupture,
          dateFinPrevue: form.date_fin_prevue,
          motifFaute: form.motif_faute,
          dateMiseEnDemeurePrealable: form.date_mise_en_demeure_prealable,
          instructionsCloture: form.instructions_cloture,
          contexte: form.contexte,
          precisions: form.precisions,
        }),
        redact: (p) => llm.redact(NOTIFICATION_DATE_SYSTEM_PROMPT, p),
        typeActionLog: "notification_date",
      });
      donneesPseudonymisees = dpNotif;

      const dossierLookupNotif = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookupNotif.ok) {
        return res.status(404).json({ error: dossierLookupNotif.error });
      }
      const dossierNotif = dossierLookupNotif.dossier;
      dossierId = dossierNotif.id;

      const [cabinetPourAdresseNotif, clientPourInfosNotif] = await Promise.all([
        prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { nom: true, adresse: true } }),
        dossierNotif.clientId
          ? prisma.client.findUnique({ where: { id: dossierNotif.clientId }, select: { civilite: true } })
          : Promise.resolve(null),
      ]);

      const civiliteClientNotif = clientPourInfosNotif?.civilite || form.civilite_client_manuel || null;

      const MODE_NOTIFICATION_LABELS: Record<string, string> = {
        huissier: "PAR EXPLOIT DE COMMISSAIRE DE JUSTICE (HUISSIER)",
        lrar: "LETTRE RECOMMANDÉE AVEC ACCUSÉ DE RÉCEPTION",
        main_propre: "REMIS EN MAIN PROPRE CONTRE DÉCHARGE",
      };
      const modeNotificationNotif = MODE_NOTIFICATION_LABELS[form.mode_notification ?? ""] || MODE_NOTIFICATION_LABELS.huissier;

      extraWebhookFields = {
        mode_notification: modeNotificationNotif,
        nom_avocat: form.nom_avocat ?? null,
        adresse_cabinet: cabinetPourAdresseNotif?.adresse || form.adresse_cabinet_manuel || null,
        nom_cabinet: cabinetPourAdresseNotif?.nom || null,
        civilite_client: civiliteClientNotif,
        civilite_nom_client: assemblerCivilite(civiliteClientNotif, dossierNotif.nomClient),
        informations_client: form.informations_client ?? null,
        destinataire: form.destinataire,
        civilite_destinataire: form.civilite_destinataire ?? null,
        civilite_nom_destinataire: assemblerCivilite(form.civilite_destinataire ?? null, form.destinataire),
        civilite_appel_destinataire: civiliteAppel(form.civilite_destinataire),
        adresse_destinataire: form.adresse_destinataire ?? null,
        objet: objetNotif,
      };

      action = {
        type_action: "notification_date",
        categorie_texte: "Notification",
        numero_dossier: dossierNotif.numeroDossier,
        nom_affaire: dossierNotif.nomAffaire,
        nom_client: dossierNotif.nomClient,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "requete") {
      const destinataireComposeRequete = composeDestinataire(form.destinataire, form.nom_juridiction, form.ville);
      // Lot 5 : le destinataire compose (peut contenir un nom de
      // confrere/partie via le cas "Maître" de composeDestinataire, pas
      // seulement une formule institutionnelle) est tokenise par
      // precaution - sans effet si c'est une formule institutionnelle,
      // protecteur si c'est un nom reel.
      const champsIdentifiantsRequete: ChampIdentifiantInput[] = [
        { champ: "destinataire", role: "PARTIE", valeur: destinataireComposeRequete },
      ];
      const { texteFinal: redigeBrutRequete, donneesPseudonymisees: dpRequete } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsRequete,
        promptTexte: buildRequeteUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: destinataireComposeRequete,
          objet: form.objet,
          contexte: form.contexte,
          fondementJuridique: form.fondement_juridique,
          montantEngage: form.montant_engage,
        }),
        redact: (p) => llm.redact(REQUETE_SYSTEM_PROMPT, p),
        typeActionLog: "requete",
      });
      donneesPseudonymisees = dpRequete;

      const blocsRequete = decouperBlocsMarques(redigeBrutRequete, ["EXPOSE_DES_FAITS", "DISCUSSION_JURIDIQUE"]);
      const exposeDesFaitsRequete = blocsRequete.EXPOSE_DES_FAITS ?? "";
      const discussionJuridiqueRequete = blocsRequete.DISCUSSION_JURIDIQUE ?? "";

      const dossierLookupRequete = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookupRequete.ok) {
        return res.status(404).json({ error: dossierLookupRequete.error });
      }
      const dossierRequete = dossierLookupRequete.dossier;
      dossierId = dossierRequete.id;

      const [cabinetPourAdresseRequete, clientPourInfosRequete] = await Promise.all([
        prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { nom: true, adresse: true } }),
        dossierRequete.clientId
          ? prisma.client.findUnique({ where: { id: dossierRequete.clientId }, select: { civilite: true } })
          : Promise.resolve(null),
      ]);

      const civiliteClientRequete = clientPourInfosRequete?.civilite || form.civilite_client_manuel || null;

      const CIVILITE_APPEL_REQUETE: Record<string, string> = {
        "M. le Président": "Monsieur le Président",
        "Mme la Présidente": "Madame la Présidente",
        "M. le Procureur de la République près": "Monsieur le Procureur de la République",
      };
      const civiliteAppelRequete = `${CIVILITE_APPEL_REQUETE[form.destinataire ?? ""] || "Monsieur le Président"},`;

      const demandesRequete = majusculerPremierVerbe(form.demandes.map((d) => `- ${d}`).join("\n"));
      const bordereauPiecesRequete =
        form.pieces && form.pieces.length > 0
          ? form.pieces.map((p, i) => `${i + 1}. ${p}`).join("\n")
          : "Aucune pièce communiquée à ce stade.";

      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees).
      const redigéRequete = [
        ["I. EXPOSÉ DES FAITS", exposeDesFaitsRequete].filter(Boolean).join("\n\n"),
        ["II. DISCUSSION JURIDIQUE", discussionJuridiqueRequete].filter(Boolean).join("\n\n"),
        [
          "PAR CES MOTIFS",
          "Et tous autres à produire, déduire ou suppléer, même d'office, il est demandé à votre juridiction de bien vouloir :",
          demandesRequete,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

      extraWebhookFields = {
        objet: form.objet,
        expose_des_faits: exposeDesFaitsRequete,
        discussion_juridique: discussionJuridiqueRequete,
        demandes: demandesRequete,
        piece_a_prevoir: bordereauPiecesRequete,
        montant_engage: form.montant_engage ?? null,
        nom_avocat: form.nom_avocat ?? null,
        adresse_cabinet: cabinetPourAdresseRequete?.adresse || form.adresse_cabinet_manuel || null,
        nom_cabinet: cabinetPourAdresseRequete?.nom || null,
        civilite_client: civiliteClientRequete,
        civilite_nom_client: assemblerCivilite(civiliteClientRequete, dossierRequete.nomClient),
        informations_client: form.informations_client ?? null,
        nationalite_client: form.nationalite_client ?? null,
        representant_legal: form.representant_legal ?? null,
        qualite_representant: form.qualite_representant ?? null,
        nom_defendeur: form.nom_defendeur ?? null,
        civilite_defendeur: form.civilite_defendeur ?? null,
        civilite_nom_defendeur: form.nom_defendeur
          ? assemblerCivilite(form.civilite_defendeur ?? null, form.nom_defendeur)
          : null,
        profession_defendeur: form.profession_defendeur ?? null,
        adresse_defendeur: form.adresse_defendeur ?? null,
        nationalite_defendeur: form.nationalite_defendeur ?? null,
        civilite_appel_destinataire: civiliteAppelRequete,
        destinataire: destinataireComposeRequete ?? null,
        nom_juridiction: form.nom_juridiction ?? null,
        ville: form.ville ?? null,
      };

      action = {
        type_action: "requete",
        categorie_texte: "Requête",
        numero_dossier: dossierRequete.numeroDossier,
        nom_affaire: dossierRequete.nomAffaire,
        nom_client: dossierRequete.nomClient,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigéRequete,
      };
    } else {
      const destinataireComposeOrdonnance = composeDestinataire(form.destinataire, form.nom_juridiction, form.ville);
      // Lot 5 : meme precaution que pour la Requete (voir plus haut).
      const champsIdentifiantsOrdonnance: ChampIdentifiantInput[] = [
        { champ: "destinataire", role: "PARTIE", valeur: destinataireComposeOrdonnance },
      ];
      const { texteFinal: redigeBrutOrdonnance, donneesPseudonymisees: dpOrdonnance } = await redigerAvecPseudonymisation({
        champsIdentifiants: champsIdentifiantsOrdonnance,
        promptTexte: buildProjetOrdonnanceUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: destinataireComposeOrdonnance,
          objet: form.objet,
          contexte: form.contexte,
          fondementJuridique: form.fondement_juridique,
          montantEngage: form.montant_engage,
        }),
        redact: (p) => llm.redact(PROJET_ORDONNANCE_SYSTEM_PROMPT, p),
        typeActionLog: "projet_ordonnance",
      });
      donneesPseudonymisees = dpOrdonnance;

      const blocsOrdonnance = decouperBlocsMarques(redigeBrutOrdonnance, ["MOTIFS"]);
      const motifsOrdonnance = blocsOrdonnance.MOTIFS ?? "";

      const dossierLookupOrdonnance = await findOrCreateDossier({
        cabinetId: auth!.cabinetId,
        userId: auth!.userId,
        numeroDossier: form.numero_dossier,
        nomAffaire: form.nom_affaire,
        nomClient: form.nom_client,
      });
      if (!dossierLookupOrdonnance.ok) {
        return res.status(404).json({ error: dossierLookupOrdonnance.error });
      }
      const dossierOrdonnance = dossierLookupOrdonnance.dossier;
      dossierId = dossierOrdonnance.id;

      const [cabinetPourAdresseOrdonnance, clientPourInfosOrdonnance] = await Promise.all([
        prisma.cabinet.findUnique({ where: { id: auth!.cabinetId }, select: { nom: true, adresse: true } }),
        dossierOrdonnance.clientId
          ? prisma.client.findUnique({ where: { id: dossierOrdonnance.clientId }, select: { civilite: true } })
          : Promise.resolve(null),
      ]);

      const civiliteClientOrdonnance = clientPourInfosOrdonnance?.civilite || form.civilite_client_manuel || null;
      const delaiOppositionOrdonnance = form.delai_opposition_jours ?? 15;

      const civiliteNomDefendeurOrdonnance = form.nom_defendeur
        ? assemblerCivilite(form.civilite_defendeur ?? null, form.nom_defendeur)
        : null;

      // Numerotee (1. 2. ...), pas a puces : c'est le formalisme observe sur
      // le dispositif d'une ordonnance d'injonction de payer reelle.
      const demandesOrdonnance = form.demandes.map((d, i) => `${i + 1}. ${d}`).join("\n");
      const bordereauPiecesOrdonnance =
        form.pieces && form.pieces.length > 0
          ? form.pieces.map((p, i) => `${i + 1}. ${p}`).join("\n")
          : "Aucune pièce communiquée à ce stade.";

      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees). "ORDONNONS
      // à... ce qui suit", "DISONS que..." et "AVISONS le débiteur..." sont
      // des formules fixes du dispositif d'une ordonnance d'injonction de
      // payer, verifiees sur un document reel issu du pipeline Google Docs -
      // jamais generees par l'IA, jamais saisies par l'avocat.
      const redigéOrdonnance = [
        motifsOrdonnance,
        [
          "PAR CES MOTIFS",
          civiliteNomDefendeurOrdonnance &&
            `**ORDONNONS** à **${civiliteNomDefendeurOrdonnance}**${
              form.profession_defendeur ? `, ${form.profession_defendeur}` : ""
            }${form.nationalite_defendeur ? `, de nationalité ${form.nationalite_defendeur}` : ""}${form.adresse_defendeur ? `, demeurant ${form.adresse_defendeur}` : ""}, ce qui suit :`,
          demandesOrdonnance,
          "**DISONS** que la présente ordonnance sera signifiée au débiteur par exploit de Commissaire de Justice (Huissier) à la diligence du créancier.",
          `**AVISONS** le débiteur qu'il dispose d'un délai de ${delaiOppositionOrdonnance} jours à compter de la signification du présent acte pour former opposition au greffe du présent Tribunal, s'il entend contester la présente décision.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

      extraWebhookFields = {
        objet: form.objet,
        motifs: motifsOrdonnance,
        demandes: demandesOrdonnance,
        piece_a_prevoir: bordereauPiecesOrdonnance,
        montant_engage: form.montant_engage ?? null,
        delai_opposition_jours: String(delaiOppositionOrdonnance),
        nom_avocat: form.nom_avocat ?? null,
        adresse_cabinet: cabinetPourAdresseOrdonnance?.adresse || form.adresse_cabinet_manuel || null,
        nom_cabinet: cabinetPourAdresseOrdonnance?.nom || null,
        civilite_client: civiliteClientOrdonnance,
        civilite_nom_client: assemblerCivilite(civiliteClientOrdonnance, dossierOrdonnance.nomClient),
        informations_client: form.informations_client ?? null,
        nationalite_client: form.nationalite_client ?? null,
        representant_legal: form.representant_legal ?? null,
        qualite_representant: form.qualite_representant ?? null,
        nom_defendeur: form.nom_defendeur ?? null,
        civilite_defendeur: form.civilite_defendeur ?? null,
        civilite_nom_defendeur: civiliteNomDefendeurOrdonnance,
        profession_defendeur: form.profession_defendeur ?? null,
        adresse_defendeur: form.adresse_defendeur ?? null,
        nationalite_defendeur: form.nationalite_defendeur ?? null,
        destinataire: destinataireComposeOrdonnance ?? null,
        nom_juridiction: form.nom_juridiction ?? null,
        ville: form.ville ?? null,
        date_requete: form.date_requete || null,
      };

      action = {
        type_action: "projet_ordonnance",
        categorie_texte: "Projet d'ordonnance",
        numero_dossier: dossierOrdonnance.numeroDossier,
        nom_affaire: dossierOrdonnance.nomAffaire,
        nom_client: dossierOrdonnance.nomClient,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigéOrdonnance,
      };
    }

    const nomDocument = computeNomDocument({
      typeAction: action.type_action,
      nomClient: action.nom_client,
      nomAdverse: nomAdversePourForm(form),
      numeroDossier: action.numero_dossier,
    });

    const savedAction = await prisma.action.create({
      data: {
        dossierId,
        typeAction: action.type_action,
        canal: "web",
        // La generation est synchrone (LLM deja appele ci-dessus) : le
        // document est complet des sa creation, jamais un brouillon en
        // attente d'un traitement externe (voir README-LOT8TER.md - l'ancien
        // circuit n8n qui generait un document Google Docs est retire ; le
        // statut avancait auparavant a la reception de son callback).
        statut: "en_attente_validation",
        contenuGenere: action.synthese ?? action.argumentaire,
        dateAudience: action.date_audience ? new Date(action.date_audience) : null,
        prochaineAudience: action.prochaine_audience ? new Date(action.prochaine_audience) : null,
        piecesPrevoir: action.pieces_prevoir,
        // Conserve les champs saisis pour permettre de pre-remplir n'importe
        // quel autre formulaire plus tard a partir de cet acte.
        champsFormulaire: form as object,
        // Identite des parties, huissier, greffier, juge, civilites,
        // adresses... : permet aux exports Word/PDF locaux de reconstruire
        // le formalisme juridique complet (voir documentFormalisme.ts).
        champsDocument: extraWebhookFields as object,
        nomDocument,
        donneesPseudonymisees,
        createdBy: auth!.userId,
      },
    });

    await logAuditStep(savedAction.id, "redaction_ia", "succes", action.categorie_texte);

    return res.status(201).json({
      dossierId,
      actionId: savedAction.id,
      contenu: action.synthese ?? action.argumentaire,
      // Lot 13 : sources jurisprudence validees (grounding + lien verifie),
      // pour affichage immediat du bloc "Source" sans devoir rouvrir le
      // document - absent (undefined) pour tout autre type d'action.
      sourcesJurisprudence: extraWebhookFields.sourcesJurisprudence,
    });
  } catch (error) {
    if (error instanceof OrphanTokenError) {
      // Fail-safe pseudonymisation (Lot 5) : AUCUN retry automatique (un
      // seul appel LLM a deja ete effectue, jamais reessaye ici), et
      // AUCUN contenu (ni en clair ni avec token visible) n'est persiste.
      // On journalise uniquement des metadonnees non sensibles (jamais le
      // prompt ni les valeurs reelles), et on trace l'echec sur une ligne
      // Action dediee (statut "echec_generation", contenuGenere null) pour
      // que le cabinet la retrouve dans son historique plutot que de voir
      // la generation disparaitre silencieusement.
      console.error(
        `[pseudonymisation] Anomalie de securite lors de la generation (type=${form.type_action}, horodatage=${new Date().toISOString()}) - document non produit.`
      );
      // TypeScript ne peut pas savoir statiquement, a ce point du catch,
      // que OrphanTokenError ne peut provenir que des branches qui
      // possedent bien ces trois champs (voir redigerAvecPseudonymisation,
      // jamais appelee pour jurisprudence/recherche_juridique/etc.) - accès
      // defensif via un type partiel plutot qu'un cast vers le type union
      // complet.
      const formPourDossier = form as { numero_dossier?: string; nom_affaire?: string; nom_client?: string };
      try {
        const lookupEchec = await findOrCreateDossier({
          cabinetId: auth!.cabinetId,
          userId: auth!.userId,
          numeroDossier: formPourDossier.numero_dossier,
          nomAffaire: formPourDossier.nom_affaire,
          nomClient: formPourDossier.nom_client,
        });
        if (lookupEchec.ok) {
          await prisma.action.create({
            data: {
              dossierId: lookupEchec.dossier.id,
              typeAction: form.type_action,
              canal: "web",
              statut: "echec_generation",
              contenuGenere: null,
              champsFormulaire: form as object,
              createdBy: auth!.userId,
            },
          });
        }
      } catch (persistError) {
        console.error("[pseudonymisation] impossible d'enregistrer la trace d'echec en base", persistError);
      }
      return res.status(422).json({
        error: "Anomalie de sécurité détectée lors de la génération — document non produit.",
      });
    }
    // Cle Gemini absente (embedText(), RAG jurisprudence - voir
    // services/embeddings.ts) : distinct de getLlmProviderSafe() plus haut,
    // qui ne verifie que la cle du fournisseur LLM actif, jamais celle de
    // Gemini specifiquement requise pour les embeddings.
    if (isMissingConfigurationError(error)) {
      console.error("[jurisprudence] recherche impossible, configuration manquante :", error.message);
      return res.status(503).json({
        error: "La recherche de jurisprudence dans la base du cabinet n'est pas configurée sur ce poste (clé API manquante). Contactez le support AzoMedIA.",
      });
    }
    if (isNetworkFetchError(error)) {
      console.error("Erreur inattendue sur /api/actions/web, echec reseau :", error);
      return res.status(503).json({
        error: "Impossible de contacter le service d'IA (vérifiez votre connexion internet), puis réessayez.",
      });
    }
    if (isGeminiQuotaError(error)) {
      console.error("[jurisprudence] recherche impossible, quota Gemini epuise :", error);
      return res.status(503).json({
        error: "Le quota de l'API IA utilisée pour la recherche dans la base du cabinet est épuisé. Contactez le support AzoMedIA pour recharger le compte.",
      });
    }
    console.error("Erreur inattendue sur /api/actions/web", error);
    return res.status(500).json({ error: "Erreur interne" });
  }
});
