import { Router } from "express";
import { z } from "zod";
import pdfParse from "pdf-parse";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { getLlmProvider } from "../services/llm";
import { callN8nWebhook, webhookForAction } from "../services/n8n";
import { logAuditStep } from "../services/audit";
import { webActionFormSchema } from "../schemas/webForms";
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
import { searchJurisprudence, formatJurisprudenceContext } from "../services/rag";
import { searchWeb, formatWebSearchContext, WebSearchResult } from "../services/tavily";
import { summarizeLongText } from "../services/resumePdf";
import { translateText, extractTextFromDocument } from "../services/traduction";
import { aiActionsLimiter } from "../middleware/rateLimit";
import { env } from "../config/env";
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

type DossierLookupResult =
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
async function findOrCreateDossier(facts: {
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

// Domaines officiels/reconnus de jurisprudence beninoise et OHADA - a
// interroger en priorite (recherche Tavily restreinte a ces domaines) avant
// de completer avec une recherche web generale. Choisis avec l'avocat du
// cabinet : bases de decisions structurees, pas de simples pages generalistes.
const JURIDICTIONS_BENIN_DOMAINES_CONFIANCE = [
  "tcc.justice.bj",
  "coursupreme.bj",
  "jurisprudencebenin.org",
  "juricaf.org",
  "ahjucaf.org",
  "ohada.org",
  "actualitesdroitohada.com",
  "ca-cot.justice.bj",
  "justice.gouv.bj",
];

// Domaines de textes officiels et de doctrine reconnus pour le droit
// beninois/OHADA - utilises par la Recherche juridique (droit general,
// textes, doctrine), distincts des bases de decisions ci-dessus meme si
// certains se recoupent (ohada.org, justice.gouv.bj).
const RECHERCHE_JURIDIQUE_DOMAINES_CONFIANCE = [
  "ohada.org",
  "justice.gouv.bj",
  "assemblee-nationale.bj",
  "sgg.gouv.bj",
  "droit-afrique.com",
  "actualitesdroitohada.com",
  "droit.cairn.info",
];

// Recherche Tavily en deux temps : une restreinte aux domaines de confiance
// fournis, une generale pour completer (Tavily ne permet pas de "prioriser
// puis se rabattre" en un seul appel - include_domains restreint totalement
// les resultats). Les resultats des domaines de confiance sont places en
// premier, dedupliques par URL avec la recherche generale.
async function searchWebPrioritaire(
  queryDomainesConfiance: string,
  queryGenerale: string,
  domainesConfiance: string[]
): Promise<WebSearchResult[]> {
  const [prioritaires, generaux] = await Promise.all([
    searchWeb(queryDomainesConfiance, 5, domainesConfiance),
    searchWeb(queryGenerale, 5),
  ]);
  const urlsVues = new Set<string>();
  const combines: WebSearchResult[] = [];
  for (const resultat of [...prioritaires, ...generaux]) {
    if (urlsVues.has(resultat.url)) continue;
    urlsVues.add(resultat.url);
    combines.push(resultat);
  }
  return combines;
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
    const llm = getLlmProvider();
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
  }
);

webActionsRouter.post("/api/actions/web", requireAuth, aiActionsLimiter, async (req, res) => {
  const parsed = webActionFormSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const form = parsed.data;
  const { auth } = req;
  const llm = getLlmProvider();

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
      const debutMois = new Date();
      debutMois.setDate(1);
      debutMois.setHours(0, 0, 0, 0);
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

  // En-tete du cabinet (logo/bandeau), insere automatiquement par n8n en
  // haut du Google Doc a chaque generation - inutile de cocher quoi que ce
  // soit, contrairement a l'insertion dans les exports Word/PDF telecharges
  // qui reste, elle, optionnelle (case a cocher).
  const cabinetPourEntete = await prisma.cabinet.findUnique({
    where: { id: auth!.cabinetId },
    select: { enteteUrl: true },
  });
  const enteteUrl =
    cabinetPourEntete?.enteteUrl && env.PUBLIC_BASE_URL
      ? `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}${cabinetPourEntete.enteteUrl}`
      : null;

  try {
    let dossierId: string;
    let action: ActionOutput;
    // Champs additionnels specifiques a certains types, transmis a n8n en
    // plus du contenu ActionOutput standard (ex: nom du defendeur et
    // juridiction pour une assignation).
    let extraWebhookFields: Record<string, unknown> = {};

    if (form.type_action === "notes") {
      const redigé = await llm.redact(
        NOTES_SYSTEM_PROMPT,
        buildNotesUserPrompt({
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
        })
      );

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
      const adresseA = composeDestinataire(
        form.destinataire,
        form.nom_juridiction,
        form.ville,
        form.nom_avocat_destinataire
      );
      const redigé = await llm.redact(
        config.systemPrompt,
        buildRedacUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          adresseA,
        })
      );

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
      const redigeBrut = await llm.redact(
        ASSIGNATION_SYSTEM_PROMPT,
        buildAssignationUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          demandeClient: form.demande_client,
          fondementJuridique: form.fondement_juridique,
          qualificationJuridique: form.qualification_juridique,
          prejudiceSubi: form.prejudice_subi,
        })
      );

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
      // locaux (qui n'ont pas de template a balises separees).
      const redigé = [
        ["I. OBJET DE LA DEMANDE", demandeClient].filter(Boolean).join("\n\n"),
        ["II. EXPOSÉ DES FAITS", exposeDesFaitsAssignation].filter(Boolean).join("\n\n"),
        ["III. DISCUSSION JURIDIQUE", fondementJuridiqueAssignation, qualificationJuridiqueAssignation, prejudiceSubiAssignation]
          .filter(Boolean)
          .join("\n\n"),
        ["EN CONSÉQUENCE", form.demandes.map((d) => `- ${d}`).join("\n")].join("\n\n"),
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
        demandes: form.demandes.map((d) => `- ${d}`).join("\n"),
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
      const redigeBrut = await llm.redact(
        CONCLUSIONS_SYSTEM_PROMPT,
        buildConclusionsUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          fondementJuridique: form.fondement_juridique,
          qualificationJuridique: form.qualification_juridique,
          prejudiceSubi: form.prejudice_subi,
          reparationDemandee: form.reparation_demandee,
          montantFraisProcedure: form.montant_frais_procedure,
          manquementAFaireJuger: form.manquement_a_faire_juger,
          demanderDepens: form.demander_depens,
        })
      );

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
      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees) : tous les
      // blocs mis bout a bout, avec des titres de section, forment un texte
      // complet et coherent.
      const redigé = [
        exposeDesFaits,
        ["DISCUSSION JURIDIQUE", fondementJuridique, qualificationJuridique, prejudiceSubi, reparationDemandee, fraisProcedure]
          .filter(Boolean)
          .join("\n\n"),
        ["PAR CES MOTIFS", manquementAJuger, condamnationDemandee].filter(Boolean).join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n");

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
        nom_partie_adverse: form.nom_partie_adverse ?? null,
        informations_partie_adverse: form.informations_partie_adverse ?? null,
        qualite_partie_adverse: form.qualite_partie_adverse ?? null,
        adresse_cabinet: adresseCabinet,
        nom_cabinet: cabinetPourAdresse?.nom || null,
        // L'avocat peut corriger/preciser le nom affiche ; sinon on retombe
        // sur celui du compte qui genere le document.
        nom_avocat: form.nom_avocat || auteur?.nom || null,
        ville: form.ville ?? null,
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
      const redigeBrut = await llm.redact(
        NOTE_PLAIDOIRIE_SYSTEM_PROMPT,
        buildNotePlaidoirieUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          fondementJuridique: form.fondement_juridique,
          qualificationJuridique: form.qualification_juridique,
          prejudiceSubi: form.prejudice_subi,
          demandes: form.demandes,
          demanderDepens: form.demander_depens,
        })
      );

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
      // locaux (qui n'ont pas de template a balises separees).
      const redigé = [
        rappelFaits,
        ["DISCUSSION JURIDIQUE", fondementJuridiqueNote, qualificationJuridiqueNote, prejudiceSubiNote]
          .filter(Boolean)
          .join("\n\n"),
        ["REPRISE DES DEMANDES", demandesNote].filter(Boolean).join("\n\n"),
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
      const exposeDesFaitsMED = await llm.redact(
        MISE_EN_DEMEURE_SYSTEM_PROMPT,
        buildMiseEnDemeureUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: form.destinataire,
          contexte: form.contexte,
          dateObligation: form.date_obligation,
          descriptionObligation: form.description_obligation,
          dateEcheancePrevue: form.date_echeance_prevue,
          montantEngage: form.montant_engage,
        })
      );

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
        `En conséquence, la présente vaut MISE EN DEMEURE, formelle et comminatoire, d'avoir à exécuter l'intégralité de vos obligations dans un délai strict de ${form.delai_jours} jours à compter de la notification du présent acte.`,
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
      // Recherche a plusieurs niveaux : Benin, zone OHADA, Afrique, France,
      // reste de la francophonie, reste du monde, via le web (Tavily) -
      // toujours effectuee. La base de jurisprudence propre au cabinet
      // n'est incluse en plus que si explicitement cochee.
      //
      const webResults = await searchWebPrioritaire(
        `${form.theme} jurisprudence Bénin`,
        `jurisprudence ${form.theme} Bénin, zone OHADA, Afrique, France, francophonie`,
        JURIDICTIONS_BENIN_DOMAINES_CONFIANCE
      );
      const cabinetMatches = form.inclure_cabinet ? await searchJurisprudence(form.theme) : [];
      const redigé = await llm.redact(
        JURISPRUDENCE_SYSTEM_PROMPT,
        buildJurisprudenceUserPrompt({
          theme: form.theme,
          juridictions: form.juridictions ?? [],
          sourcesWeb: formatWebSearchContext(webResults),
          sourcesCabinet: form.inclure_cabinet ? formatJurisprudenceContext(cabinetMatches) : undefined,
        })
      );

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
      const resultats = await searchWebPrioritaire(
        form.question,
        form.question,
        RECHERCHE_JURIDIQUE_DOMAINES_CONFIANCE
      );
      const redigé = await llm.redact(
        RECHERCHE_JURIDIQUE_SYSTEM_PROMPT,
        buildRechercheJuridiqueUserPrompt({
          question: form.question,
          resultatsRecherche: formatWebSearchContext(resultats),
        })
      );

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
      const redigeBrutPlainte = await llm.redact(
        PLAINTE_SYSTEM_PROMPT,
        buildPlainteUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          nomDefendeur: form.nom_defendeur,
          contexte: form.contexte,
          qualificationInfraction: form.qualification_infraction,
          dateFaits: form.date_faits,
          descriptionAccord: form.description_accord,
          montantEngage: form.montant_engage,
          fondementJuridique: form.fondement_juridique,
        })
      );

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
      // locaux (qui n'ont pas de template a balises separees).
      const redigéPlainte = [
        ["I. EXPOSÉ DES FAITS", exposeDesFaitsPlainte].filter(Boolean).join("\n\n"),
        ["II. DISCUSSION JURIDIQUE", discussionJuridiquePlainte].filter(Boolean).join("\n\n"),
        ["PAR CES MOTIFS", demandesPlainte].filter(Boolean).join("\n\n"),
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
        profession_client: form.profession_client ?? null,
        civilite_client: civiliteClientPlainte,
        civilite_nom_client: assemblerCivilite(civiliteClientPlainte, dossierPlainte.nomClient),
        informations_client: informationsClientPlainte,
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
      const redigeBrutContrat = await llm.redact(
        CONTRAT_SYSTEM_PROMPT,
        buildContratUserPrompt({
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
        })
      );

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
        partie_2: form.partie_2 ?? null,
        informations_partie_2: form.informations_partie_2 ?? null,
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

      const redigé = await llm.redact(
        NOTIFICATION_DATE_SYSTEM_PROMPT,
        buildNotificationDateUserPrompt({
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
        })
      );

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
      const redigeBrutRequete = await llm.redact(
        REQUETE_SYSTEM_PROMPT,
        buildRequeteUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: destinataireComposeRequete,
          objet: form.objet,
          contexte: form.contexte,
          fondementJuridique: form.fondement_juridique,
          montantEngage: form.montant_engage,
        })
      );

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

      const demandesRequete = form.demandes.map((d) => `- ${d}`).join("\n");
      const bordereauPiecesRequete =
        form.pieces && form.pieces.length > 0
          ? form.pieces.map((p, i) => `${i + 1}. ${p}`).join("\n")
          : "Aucune pièce communiquée à ce stade.";

      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees).
      const redigéRequete = [
        ["I. EXPOSÉ DES FAITS", exposeDesFaitsRequete].filter(Boolean).join("\n\n"),
        ["II. DISCUSSION JURIDIQUE", discussionJuridiqueRequete].filter(Boolean).join("\n\n"),
        ["PAR CES MOTIFS", demandesRequete].filter(Boolean).join("\n\n"),
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
        representant_legal: form.representant_legal ?? null,
        qualite_representant: form.qualite_representant ?? null,
        nom_defendeur: form.nom_defendeur ?? null,
        civilite_defendeur: form.civilite_defendeur ?? null,
        civilite_nom_defendeur: form.nom_defendeur
          ? assemblerCivilite(form.civilite_defendeur ?? null, form.nom_defendeur)
          : null,
        profession_defendeur: form.profession_defendeur ?? null,
        adresse_defendeur: form.adresse_defendeur ?? null,
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
      const redigeBrutOrdonnance = await llm.redact(
        PROJET_ORDONNANCE_SYSTEM_PROMPT,
        buildProjetOrdonnanceUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: destinataireComposeOrdonnance,
          objet: form.objet,
          contexte: form.contexte,
          fondementJuridique: form.fondement_juridique,
          montantEngage: form.montant_engage,
        })
      );

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

      const demandesOrdonnance = form.demandes.map((d) => `- ${d}`).join("\n");
      const bordereauPiecesOrdonnance =
        form.pieces && form.pieces.length > 0
          ? form.pieces.map((p, i) => `${i + 1}. ${p}`).join("\n")
          : "Aucune pièce communiquée à ce stade.";

      // Utilise pour le contenu enregistre en base et les exports Word/PDF
      // locaux (qui n'ont pas de template a balises separees).
      const redigéOrdonnance = [
        ["MOTIFS", motifsOrdonnance].filter(Boolean).join("\n\n"),
        ["PAR CES MOTIFS", demandesOrdonnance].filter(Boolean).join("\n\n"),
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
        representant_legal: form.representant_legal ?? null,
        qualite_representant: form.qualite_representant ?? null,
        nom_defendeur: form.nom_defendeur ?? null,
        civilite_defendeur: form.civilite_defendeur ?? null,
        civilite_nom_defendeur: form.nom_defendeur
          ? assemblerCivilite(form.civilite_defendeur ?? null, form.nom_defendeur)
          : null,
        profession_defendeur: form.profession_defendeur ?? null,
        adresse_defendeur: form.adresse_defendeur ?? null,
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
        contenuGenere: action.synthese ?? action.argumentaire,
        dateAudience: action.date_audience ? new Date(action.date_audience) : null,
        prochaineAudience: action.prochaine_audience ? new Date(action.prochaine_audience) : null,
        piecesPrevoir: action.pieces_prevoir,
        // Conserve les champs saisis pour permettre de pre-remplir n'importe
        // quel autre formulaire plus tard a partir de cet acte.
        champsFormulaire: form as object,
        nomDocument,
        createdBy: auth!.userId,
      },
    });

    await logAuditStep(savedAction.id, "redaction_ia", "succes", action.categorie_texte);

    const n8nResult = await callN8nWebhook(webhookForAction(action.type_action), {
      ...action,
      dossierId,
      actionId: savedAction.id,
      enteteUrl,
      nom_document: nomDocument,
      ...extraWebhookFields,
    });

    await logAuditStep(
      savedAction.id,
      "declenchement_n8n",
      n8nResult.ok ? "succes" : "erreur",
      n8nResult.error
    );

    return res.status(201).json({
      dossierId,
      actionId: savedAction.id,
      contenu: action.synthese ?? action.argumentaire,
      n8nDispatched: n8nResult.ok,
    });
  } catch (error) {
    console.error("Erreur inattendue sur /api/actions/web", error);
    return res.status(500).json({ error: "Erreur interne" });
  }
});
