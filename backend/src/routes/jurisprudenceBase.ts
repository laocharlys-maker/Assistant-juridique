import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireModule } from "../middleware/roles";
import { isMissingConfigurationError } from "../lib/configurationError";
import { isNetworkFetchError, isGeminiQuotaError } from "../lib/networkError";
import { indexerDecision } from "../services/jurisprudence/indexerDecision";
import { extraireTextePdf, pdfBufferDepuisDataUrl } from "../services/pdfExtraction";
import { lirePdfJurisprudence, supprimerPdfJurisprudence } from "../services/jurisprudence/stockagePdf";

export const jurisprudenceBaseRouter = Router();

// Module payant : peut etre desactive par la plateforme pour un cabinet
// dont la formule ne l'inclut pas. Chemin explicite obligatoire : sans lui,
// ce middleware s'appliquerait a TOUTES les requetes de l'app (ce routeur
// est monte sans prefixe sur app), pas seulement a /api/jurisprudence-base*.
jurisprudenceBaseRouter.use("/api/jurisprudence-base", requireAuth, requireModule("jurisprudence"));

jurisprudenceBaseRouter.get("/api/jurisprudence-base", requireAuth, async (_req, res) => {
  // Sans try/catch, une erreur ici (ex: extension Postgres "vector" ou
  // table jurisprudence_chunks manquante sur cet environnement) resterait
  // une promesse rejetee non rattrapee - avec le filet de securite de
  // index.ts (process.on("unhandledRejection", ...)), cela arrete TOUT le
  // backend, pas seulement cette requete. D'ou ce try/catch explicite,
  // comme sur POST /api/jurisprudence-base ci-dessous.
  try {
    const entries = await prisma.jurisprudenceChunk.findMany({
      select: {
        id: true,
        source: true,
        reference: true,
        juridiction: true,
        dateDecision: true,
        contenu: true,
        lien: true,
        groupeId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
    return res.json(entries);
  } catch (error) {
    console.error("Erreur chargement base de jurisprudence :", error);
    return res.status(500).json({ error: "Impossible de charger la base de jurisprudence (voir logs serveur)" });
  }
});

const createEntrySchema = z.object({
  source: z.string().min(1),
  reference: z.string().min(1),
  juridiction: z.string().optional(),
  dateDecision: z.string().optional(),
  contenu: z.string().min(20, "Le contenu doit être suffisamment détaillé pour être utile"),
  // Lot 13 : lien reel vers la decision - optionnel a la saisie (le corpus
  // existant n'en a pas), mais fortement recommande : une citation issue
  // d'un chunk sans lien n'est jamais affichee dans une recherche de
  // jurisprudence (voir services/jurisprudence/grounding.ts).
  lien: z.string().url("Le lien doit être une URL valide (https://...)").optional().or(z.literal("")),
});

jurisprudenceBaseRouter.post("/api/jurisprudence-base", requireAuth, async (req, res) => {
  const parsed = createEntrySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  const { source, reference, juridiction, dateDecision, contenu, lien } = parsed.data;

  try {
    // Lot 18 : nettoyage puis decoupage en chunks (voir
    // services/jurisprudence/indexerDecision.ts, partagee avec la
    // passerelle resume PDF -> jurisprudence de routes/webActions.ts).
    const { groupeId, ids: idsCrees, chunkCount } = await indexerDecision({
      source,
      reference,
      juridiction: juridiction ?? null,
      dateDecision: dateDecision ?? null,
      contenuBrut: contenu,
      lien: lien || null,
    });

    return res.status(201).json({ ids: idsCrees, groupeId, chunkCount });
  } catch (error) {
    // MissingConfigurationError (cle Gemini absente - embedText() en a
    // besoin quel que soit LLM_PROVIDER, voir embeddings.ts) distingue du
    // reste : message clair plutot que noye dans "echec de l'indexation",
    // qui laissait a tort penser a un probleme reseau/Postgres ponctuel.
    if (isMissingConfigurationError(error)) {
      console.error("[jurisprudence] indexation impossible, configuration manquante :", error.message);
      return res.status(503).json({
        error: "L'indexation de jurisprudence n'est pas configurée sur ce poste (clé API manquante). Contactez le support AzoMedIA.",
      });
    }
    if (isNetworkFetchError(error)) {
      console.error("[jurisprudence] indexation impossible, echec reseau :", error);
      return res.status(503).json({
        error: "Impossible de contacter le service d'IA (vérifiez votre connexion internet), puis réessayez.",
      });
    }
    if (isGeminiQuotaError(error)) {
      console.error("[jurisprudence] indexation impossible, quota Gemini epuise :", error);
      return res.status(503).json({
        error: "Le quota de l'API IA utilisée pour l'indexation est épuisé. Contactez le support AzoMedIA pour recharger le compte.",
      });
    }
    console.error("Erreur ajout jurisprudence :", error);
    return res.status(502).json({ error: "Échec de l'indexation (voir logs serveur)" });
  }
});

const extrairePdfSchema = z.object({
  pdfDataUrl: z.string().min(1),
});

// Lot 18 : confort de saisie uniquement - extrait le texte d'un PDF pour
// PRE-REMPLIR le champ "contenu" du formulaire cote frontend. Ne cree
// jamais rien en base elle-meme : le texte extrait suit ensuite exactement
// le meme chemin (relecture/correction par l'avocat, POST explicite,
// nettoyage, chunking) que la saisie manuelle - voir
// public/jurisprudence-base.html.
jurisprudenceBaseRouter.post("/api/jurisprudence-base/extraire-pdf", requireAuth, async (req, res) => {
  const parsed = extrairePdfSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide" });
  }
  const pdfBuffer = pdfBufferDepuisDataUrl(parsed.data.pdfDataUrl);
  const extraction = await extraireTextePdf(pdfBuffer);
  if (!extraction.ok) {
    return res.status(400).json({ error: extraction.error });
  }
  return res.json({ texte: extraction.texte });
});

// Passerelle resume PDF -> jurisprudence : consultation du PDF stocke de
// facon chiffree pour une decision donnee (voir
// services/jurisprudence/stockagePdf.ts). C'est CETTE route, jamais une URL
// web, qui est enregistree comme champ "lien" du/des JurisprudenceChunk
// crees par routes/webActions.ts quand la case "Ajouter aussi cette
// decision a ma base de jurisprudence" est cochee.
jurisprudenceBaseRouter.get("/api/jurisprudence-base/:groupeId/document", requireAuth, async (req, res) => {
  try {
    const pdf = await prisma.jurisprudencePdf.findUnique({ where: { groupeId: req.params.groupeId } });
    if (!pdf) {
      return res.status(404).json({ error: "Document introuvable" });
    }
    const buffer = await lirePdfJurisprudence(pdf.nomFichier);
    // Nom d'origine saisi par l'avocat au moment de l'upload - jamais
    // recopie tel quel dans un en-tete HTTP (CR/LF pourraient y etre
    // interpretes comme un debut de nouvel en-tete).
    const nomSur = pdf.nomOriginal.replace(/[\r\n"]/g, "");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nomSur}"`);
    return res.send(buffer);
  } catch (error) {
    console.error("Erreur lecture document jurisprudence :", error);
    return res.status(500).json({ error: "Impossible de lire le document (voir logs serveur)" });
  }
});

const updateLienSchema = z.object({
  lien: z.string().url("Le lien doit être une URL valide (https://...)").optional().or(z.literal("")),
});

/**
 * Determine le filtre a appliquer pour agir sur TOUS les chunks d'une meme
 * decision (PATCH du lien, DELETE) : si le chunk cible appartient a un
 * groupe (decision multi-chunkee, ou meme une decision a un seul chunk
 * mais indexee depuis ce lot - voir jurisprudenceBase.ts POST, groupeId
 * toujours genere desormais), TOUS les chunks du groupe sont vises.
 * Repli sur l'id seul pour le corpus indexe AVANT ce lot (groupeId
 * absent). Exportee pure (aucun acces Prisma) pour un test direct de
 * cette logique de branchement, partagee par PATCH et DELETE.
 */
export function construireFiltreGroupe(
  chunk: { id: string; groupeId: string | null } | null,
  idDemande: string
): { groupeId: string } | { id: string } | null {
  if (!chunk) return null;
  return chunk.groupeId ? { groupeId: chunk.groupeId } : { id: idDemande };
}

// Lot 13 : permet de completer le lien d'une source deja indexee (corpus
// existant avant ce lot, ou saisie initiale sans lien) sans avoir a la
// supprimer/reindexer - seul le lien change, jamais le contenu ni
// l'embedding. Lot 18 : si la decision a ete decoupee en plusieurs chunks,
// le lien de TOUS ses chunks est mis a jour en une seule operation (voir
// construireFiltreGroupe ci-dessus).
jurisprudenceBaseRouter.patch("/api/jurisprudence-base/:id", requireAuth, async (req, res) => {
  const parsed = updateLienSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }
  try {
    const chunk = await prisma.jurisprudenceChunk.findUnique({
      where: { id: req.params.id },
      select: { id: true, groupeId: true },
    });
    const filtre = construireFiltreGroupe(chunk, req.params.id);
    if (!filtre) {
      return res.status(404).json({ error: "Source introuvable" });
    }
    const updated = await prisma.jurisprudenceChunk.updateMany({
      where: filtre,
      data: { lien: parsed.data.lien || null },
    });
    if (updated.count === 0) {
      return res.status(404).json({ error: "Source introuvable" });
    }
    return res.json({ ok: true, chunksModifies: updated.count });
  } catch (error) {
    console.error("Erreur mise à jour du lien de jurisprudence :", error);
    return res.status(500).json({ error: "Impossible d'enregistrer le lien (voir logs serveur)" });
  }
});

// Lot 18 (correctif) : supprime TOUS les chunks de la meme decision, pas
// seulement celui vise par :id - une decision multi-chunkee ne doit
// jamais laisser de chunks orphelins apres suppression (voir
// construireFiltreGroupe ci-dessus, meme logique que PATCH).
jurisprudenceBaseRouter.delete("/api/jurisprudence-base/:id", requireAuth, async (req, res) => {
  try {
    const chunk = await prisma.jurisprudenceChunk.findUnique({
      where: { id: req.params.id },
      select: { id: true, groupeId: true },
    });
    const filtre = construireFiltreGroupe(chunk, req.params.id);
    if (!filtre) {
      return res.json({ ok: true, chunksSupprimes: 0 });
    }
    const deleted = await prisma.jurisprudenceChunk.deleteMany({ where: filtre });

    // Passerelle resume PDF -> jurisprudence : si cette decision provient
    // d'un PDF stocke (voir services/jurisprudence/stockagePdf.ts), son
    // fichier chiffre et sa metadonnee doivent disparaitre avec elle -
    // jamais de PDF orphelin sur disque apres suppression de la decision.
    if ("groupeId" in filtre) {
      const pdf = await prisma.jurisprudencePdf.findUnique({ where: { groupeId: filtre.groupeId } });
      if (pdf) {
        await supprimerPdfJurisprudence(pdf.nomFichier);
        await prisma.jurisprudencePdf.delete({ where: { groupeId: filtre.groupeId } });
      }
    }

    return res.json({ ok: true, chunksSupprimes: deleted.count });
  } catch (error) {
    console.error("Erreur suppression jurisprudence :", error);
    return res.status(500).json({ error: "Impossible de supprimer la source (voir logs serveur)" });
  }
});
