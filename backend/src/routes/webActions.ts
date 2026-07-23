import { Router } from "express";
import pdfParse from "pdf-parse";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { getLlmProvider } from "../services/llm";
import { callN8nWebhook, webhookForAction } from "../services/n8n";
import { logAuditStep } from "../services/audit";
import { webActionFormSchema } from "../schemas/webForms";
import {
  NOTES_SYSTEM_PROMPT,
  REDAC_SYSTEM_PROMPT,
  CONCLUSIONS_SYSTEM_PROMPT,
  ASSIGNATION_SYSTEM_PROMPT,
  MISE_EN_DEMEURE_SYSTEM_PROMPT,
  JURISPRUDENCE_SYSTEM_PROMPT,
  RECHERCHE_JURIDIQUE_SYSTEM_PROMPT,
  PLAINTE_SYSTEM_PROMPT,
  CONTRAT_SYSTEM_PROMPT,
  NOTIFICATION_DATE_SYSTEM_PROMPT,
  REQUETE_SYSTEM_PROMPT,
  buildNotesUserPrompt,
  buildRedacUserPrompt,
  buildMiseEnDemeureUserPrompt,
  buildJurisprudenceUserPrompt,
  buildRechercheJuridiqueUserPrompt,
  buildPlainteUserPrompt,
  buildContratUserPrompt,
  buildNotificationDateUserPrompt,
  buildRequeteUserPrompt,
} from "../prompts/webRedaction";
import { ActionOutput } from "../schemas/action";
import { searchJurisprudence, formatJurisprudenceContext } from "../services/rag";
import { searchWeb, formatWebSearchContext } from "../services/tavily";
import { summarizeLongText } from "../services/resumePdf";
import { translateText, extractTextFromDocument } from "../services/traduction";
import { aiActionsLimiter } from "../middleware/rateLimit";

export const webActionsRouter = Router();

// redac / conclusions / assignation partagent la meme forme de donnees
// (dossier existant + contexte + axes d'argumentation), seuls le prompt et
// le libelle changent.
const TEXTE_JURIDIQUE_CONFIG = {
  redac: { systemPrompt: REDAC_SYSTEM_PROMPT, categorieTexte: "Plaidoirie" },
  conclusions: { systemPrompt: CONCLUSIONS_SYSTEM_PROMPT, categorieTexte: "Conclusions" },
  assignation: { systemPrompt: ASSIGNATION_SYSTEM_PROMPT, categorieTexte: "Assignation" },
} as const;

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
  const numeroDossier = facts.numeroDossier?.trim() || "SANS-NUMERO";

  const existing = await prisma.dossier.findFirst({
    where: { cabinetId: facts.cabinetId, numeroDossier },
  });
  if (existing) return { ok: true, dossier: existing };

  // Si aucun numero n'a ete fourni, on cree le dossier partage "SANS-NUMERO"
  // avec des valeurs par defaut plutot que d'exiger le nom du client.
  const nomClient = facts.nomClient || (numeroDossierFourni ? undefined : "Non précisé");
  if (!nomClient) {
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

// Compose l'adresse du destinataire d'un courrier (plainte) a partir de 3
// champs facultatifs et independants (civilite, juridiction, ville) saisis
// via des listes deroulantes - jamais devine, uniquement assemble a partir
// de ce qui est fourni.
function composeDestinataire(
  civilite?: string,
  juridiction?: string,
  ville?: string
): string | undefined {
  if (!civilite) return undefined;
  if (!juridiction) return ville ? `${civilite} de ${ville}` : civilite;

  const genre = JURIDICTIONS_BENIN_GENRE[juridiction];
  const connecteur = civilite.trim().endsWith("près") ? genre?.article ?? "le" : genre?.possessif ?? "du";
  return `${civilite} ${connecteur} ${juridiction}${ville ? ` de ${ville}` : ""}`;
}

webActionsRouter.post("/api/actions/web", requireAuth, aiActionsLimiter, async (req, res) => {
  const parsed = webActionFormSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const form = parsed.data;
  const { auth } = req;
  const llm = getLlmProvider();

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
          decision: form.decision,
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

      action = {
        type_action: "notes",
        categorie_texte: "Compte-rendu d'audience",
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
        nom_client: form.nom_client,
        nom_juridiction: form.nom_juridiction ?? null,
        nom_chambre: form.nom_chambre ?? null,
        date_audience: new Date().toISOString().slice(0, 10),
        decision: form.decision,
        prochaine_audience: form.prochaine_audience ?? null,
        pieces_prevoir: form.pieces_prevoir?.join(", ") ?? null,
        synthese: redigé,
        argumentaire: null,
      };
    } else if (
      form.type_action === "redac" ||
      form.type_action === "conclusions" ||
      form.type_action === "assignation"
    ) {
      const config = TEXTE_JURIDIQUE_CONFIG[form.type_action];
      const destinataire = form.type_action === "assignation" ? form.destinataire : undefined;
      const demandes = form.type_action === "assignation" ? form.demandes : undefined;
      const pieces = form.type_action === "assignation" ? form.pieces : undefined;
      const redigé = await llm.redact(
        config.systemPrompt,
        buildRedacUserPrompt({
          nomAffaire: form.nom_affaire || "non précisée",
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          destinataire,
          demandes,
          pieces,
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

      // Le nom affiche cote "destinataire" du document depend du type : le
      // client lui-meme pour des conclusions ; la plaidoirie reste sur le
      // template generique (pas de destinataire affiche). Pour une
      // assignation, nom_client reste le VRAI client (voir extraWebhookFields
      // plus bas pour le defendeur et la juridiction, distincts du client).
      const nomClientAffiche =
        form.type_action === "conclusions" || form.type_action === "assignation"
          ? dossier.nomClient
          : null;

      if (form.type_action === "assignation") {
        extraWebhookFields = {
          nom_defendeur: form.destinataire,
          nom_avocat: form.nom_avocat,
          nom_huissier: form.nom_huissier,
          nom_juridiction: form.nom_juridiction,
          nom_chambre: form.nom_chambre ?? null,
        };
      }

      action = {
        type_action: form.type_action,
        categorie_texte: config.categorieTexte,
        numero_dossier: dossier.numeroDossier,
        nom_affaire: dossier.nomAffaire,
        nom_client: nomClientAffiche,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "mise_en_demeure") {
      const redigé = await llm.redact(
        MISE_EN_DEMEURE_SYSTEM_PROMPT,
        buildMiseEnDemeureUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: form.destinataire,
          contexte: form.contexte,
          delaiJours: form.delai_jours,
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
      dossierId = dossierLookup.dossier.id;

      action = {
        type_action: "mise_en_demeure",
        categorie_texte: "Mise en demeure",
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
        nom_client: form.destinataire,
        nom_juridiction: null,
        nom_chambre: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else if (form.type_action === "jurisprudence") {
      const matches = await searchJurisprudence(form.theme);
      const redigé = await llm.redact(
        JURISPRUDENCE_SYSTEM_PROMPT,
        buildJurisprudenceUserPrompt({
          theme: form.theme,
          juridictions: form.juridictions ?? [],
          sourcesVerifiees: formatJurisprudenceContext(matches),
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
      const resultats = await searchWeb(form.question);
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
      const redigé = await llm.redact(
        PLAINTE_SYSTEM_PROMPT,
        buildPlainteUserPrompt({
          nomAffaire: form.nom_affaire,
          nomDefendeur: form.nom_defendeur,
          destinataire: form.destinataire,
          juridiction: form.nom_juridiction,
          motifs: form.motifs,
          demandes: form.demandes,
          preuves: form.preuves,
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
      dossierId = dossierLookup.dossier.id;

      extraWebhookFields = {
        nom_defendeur: form.nom_defendeur,
        nom_avocat: form.nom_avocat,
        nom_juridiction: form.nom_juridiction ?? null,
        nom_chambre: form.nom_chambre ?? null,
        destinataire: composeDestinataire(form.destinataire, form.nom_juridiction, form.ville) ?? null,
      };

      action = {
        type_action: "plainte",
        categorie_texte: "Plainte",
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
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
    } else if (form.type_action === "contrat") {
      const redigé = await llm.redact(
        CONTRAT_SYSTEM_PROMPT,
        buildContratUserPrompt({
          typeContrat: form.type_contrat ?? "non précisé",
          partie1: form.partie_1 ?? "non précisé",
          partie2: form.partie_2 ?? "non précisé",
          objet: form.objet ?? "non précisé",
          obligations: form.obligations ?? "non précisé",
          duree: form.duree,
          remuneration: form.remuneration,
          dateEffet: form.date_effet,
          conditionsResiliation: form.conditions_resiliation,
          clausesParticulieres: form.clauses_particulieres,
          estAvenant: form.est_avenant ?? false,
          referenceContratInitial: form.reference_contrat_initial,
          objetAvenant: form.objet_avenant,
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
      dossierId = dossierLookup.dossier.id;

      action = {
        type_action: "contrat",
        categorie_texte: form.est_avenant ? "Avenant au contrat" : "Contrat",
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
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
      const redigé = await llm.redact(
        NOTIFICATION_DATE_SYSTEM_PROMPT,
        buildNotificationDateUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: form.destinataire,
          objet: form.objet,
          dateNotifiee: form.date_notifiee,
          lieu: form.lieu,
          juridiction: form.nom_juridiction,
          precisions: form.precisions,
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
      dossierId = dossierLookup.dossier.id;

      action = {
        type_action: "notification_date",
        categorie_texte: "Notification de date",
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
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
    } else {
      const destinataireCompose = composeDestinataire(form.destinataire, form.nom_juridiction, form.ville);
      const redigé = await llm.redact(
        REQUETE_SYSTEM_PROMPT,
        buildRequeteUserPrompt({
          nomAffaire: form.nom_affaire,
          destinataire: destinataireCompose,
          objet: form.objet,
          motifs: form.motifs,
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
      dossierId = dossierLookup.dossier.id;

      action = {
        type_action: "requete",
        categorie_texte: "Requête",
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
    }

    const savedAction = await prisma.action.create({
      data: {
        dossierId,
        typeAction: action.type_action,
        canal: "web",
        contenuGenere: action.synthese ?? action.argumentaire,
        dateAudience: action.date_audience ? new Date(action.date_audience) : null,
        prochaineAudience: action.prochaine_audience ? new Date(action.prochaine_audience) : null,
        piecesPrevoir: action.pieces_prevoir,
        createdBy: auth!.userId,
      },
    });

    await logAuditStep(savedAction.id, "redaction_ia", "succes", action.categorie_texte);

    const n8nResult = await callN8nWebhook(webhookForAction(action.type_action), {
      ...action,
      dossierId,
      actionId: savedAction.id,
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
