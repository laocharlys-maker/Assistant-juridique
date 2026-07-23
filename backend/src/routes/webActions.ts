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
  buildNotesUserPrompt,
  buildRedacUserPrompt,
  buildMiseEnDemeureUserPrompt,
  buildJurisprudenceUserPrompt,
  buildRechercheJuridiqueUserPrompt,
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

// Utilise pour redac/conclusions/assignation/mise_en_demeure : si le dossier
// existe deja on le reutilise tel quel, sinon on le cree a la volee (utile
// pour une nouvelle affaire qui commence directement par une assignation ou
// une mise en demeure, sans compte-rendu d'audience prealable) - mais il
// faut alors le nom du client, jamais devine.
async function findOrCreateDossier(facts: {
  cabinetId: string;
  userId: string;
  numeroDossier: string;
  nomAffaire: string;
  nomClient?: string;
}): Promise<DossierLookupResult> {
  const existing = await prisma.dossier.findFirst({
    where: { cabinetId: facts.cabinetId, numeroDossier: facts.numeroDossier },
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
      numeroDossier: facts.numeroDossier,
      nomAffaire: facts.nomAffaire,
      nomClient: facts.nomClient,
      createdBy: facts.userId,
    },
  });
  return { ok: true, dossier };
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

    if (form.type_action === "notes") {
      const redigé = await llm.redact(
        NOTES_SYSTEM_PROMPT,
        buildNotesUserPrompt({
          numeroDossier: form.numero_dossier,
          nomAffaire: form.nom_affaire,
          nomClient: form.nom_client,
          nomJuge: form.nom_juge,
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
          nomJuge: form.nom_juge,
        },
        create: {
          cabinetId: auth!.cabinetId,
          numeroDossier: form.numero_dossier,
          nomAffaire: form.nom_affaire,
          nomClient: form.nom_client,
          nomJuge: form.nom_juge,
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
        nom_juge: form.nom_juge ?? null,
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
      const redigé = await llm.redact(
        config.systemPrompt,
        buildRedacUserPrompt({
          nomAffaire: form.nom_affaire,
          contexte: form.contexte,
          axesArgumentation: form.axes_argumentation,
          destinataire,
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

      // Le destinataire affiche sur le document depend du type : le defendeur
      // assigne pour une assignation, le client pour des conclusions ; la
      // plaidoirie reste sur le template generique (pas de destinataire affiche).
      const nomClientAffiche =
        form.type_action === "assignation"
          ? form.destinataire
          : form.type_action === "conclusions"
            ? dossier.nomClient
            : null;

      action = {
        type_action: form.type_action,
        categorie_texte: config.categorieTexte,
        numero_dossier: form.numero_dossier,
        nom_affaire: form.nom_affaire,
        nom_client: nomClientAffiche,
        nom_juge: null,
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
        nom_juge: null,
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
        nom_juge: null,
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
        nom_juge: null,
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
        nom_juge: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: redigé,
      };
    } else {
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
        nom_juge: null,
        date_audience: null,
        decision: null,
        prochaine_audience: null,
        pieces_prevoir: null,
        synthese: null,
        argumentaire: traduit,
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
