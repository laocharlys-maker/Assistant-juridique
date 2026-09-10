import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { env } from "../config/env";
import { enregistrerFichier, lireFichier } from "../services/stockageDocuments";
import { buildDocx } from "../services/documentExport";
import { loadExportInput } from "./documentExport";
import { logAuditStep } from "../services/audit";

export const actionVersionsFichierRouter = Router();

/**
 * Versions FICHIER d'une action (aller-retour Word) - voir schema.prisma,
 * modele ActionVersionFichier. Distinct du systeme de versions TEXTE
 * (ActionVersion, routes/actionVersions.ts) : ici, chaque version est un
 * vrai fichier .docx uploade (commentaires/suivi des modifications faits
 * dans Word, sans equivalent dans l'editeur texte d'Aurore), stocke
 * chiffre sur disque comme n'importe quelle piece de dossier.
 */

const TYPES_WORD = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const DATA_URL_PATTERN = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.+)$/;

async function chargerActionAccessible(actionId: string, cabinetId: string) {
  return prisma.action.findFirst({
    where: { id: actionId, dossier: { cabinetId } },
    include: { dossier: true },
  });
}

const INCLUDE_STANDARD = {
  auteur: { select: { id: true, nom: true } },
} as const;

actionVersionsFichierRouter.get("/api/actions/:id/versions-fichier", requireAuth, async (req, res) => {
  const action = await chargerActionAccessible(req.params.id, req.auth!.cabinetId);
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }

  const versions = await prisma.actionVersionFichier.findMany({
    where: { actionId: action.id },
    orderBy: { numero: "desc" },
    include: INCLUDE_STANDARD,
  });
  return res.json(versions);
});

const uploadSchema = z.object({
  nom: z.string().min(1),
  fichierDataUrl: z.string().min(1),
});

// Charge une nouvelle version (upload d'un .docx corrige). Au tout premier
// upload pour cette action, genere ET insere automatiquement la "Version 1"
// a partir du contenu actuel (buildDocx, sans signature/entete - le
// document "brut" tel qu'il etait avant toute correction externe) avant
// d'inserer la version uploadee juste apres - jamais de Version 1 "vide".
actionVersionsFichierRouter.post("/api/actions/:id/versions-fichier", requireAuth, async (req, res) => {
  const action = await chargerActionAccessible(req.params.id, req.auth!.cabinetId);
  if (!action) {
    return res.status(404).json({ error: "Action introuvable" });
  }

  const dernieresVersions = await prisma.actionVersionFichier.findMany({
    where: { actionId: action.id },
    orderBy: { numero: "desc" },
    take: 1,
  });
  const derniere = dernieresVersions[0];

  // Une fois une version validee, seul un avocat/titulaire peut en charger
  // une nouvelle par-dessus - un collaborateur reste libre de le faire tant
  // qu'aucune version n'a encore ete validee (meme esprit que le reste de
  // l'appli : la validation reste le seul geste reserve a l'avocat, jamais
  // un blocage total du collaborateur sur un document pas encore fige).
  if (derniere?.estVersionValidee && req.auth!.role === "collaborateur") {
    return res.status(403).json({
      error: "La dernière version de ce document est déjà validée : seul un avocat du cabinet peut la modifier.",
    });
  }

  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Formulaire invalide", details: parsed.error.issues });
  }

  const match = parsed.data.fichierDataUrl.match(DATA_URL_PATTERN);
  if (!match) {
    return res.status(400).json({ error: "Fichier invalide (format inattendu)." });
  }
  const [, typeMime, base64Data] = match;
  if (!TYPES_WORD.has(typeMime)) {
    return res.status(415).json({ error: "Seuls les fichiers Word (.doc/.docx) sont acceptés ici." });
  }

  const contenu = Buffer.from(base64Data, "base64");
  if (contenu.length === 0) {
    return res.status(400).json({ error: "Fichier vide." });
  }
  const tailleMaxOctets = env.DOCUMENTS_TAILLE_MAX_MO * 1024 * 1024;
  if (contenu.length > tailleMaxOctets) {
    return res.status(413).json({
      error: `Fichier trop volumineux (${(contenu.length / (1024 * 1024)).toFixed(1)} Mo) — la taille maximale autorisée est de ${env.DOCUMENTS_TAILLE_MAX_MO} Mo.`,
    });
  }

  let prochainNumero = (derniere?.numero ?? 0) + 1;

  const versionsACreer: {
    numero: number;
    nomOriginal: string;
    typeMime: string;
    contenu: Buffer;
    auteurId: string;
  }[] = [];

  if (!derniere) {
    // Tout premier upload pour cette action : fige d'abord l'etat actuel
    // comme Version 1, avant d'inserer la correction en Version 2.
    const loaded = await loadExportInput(action.id, req.auth!.cabinetId);
    if (loaded) {
      try {
        const buffer = await buildDocx(loaded.input);
        versionsACreer.push({
          numero: prochainNumero,
          nomOriginal: `${loaded.action.nomDocument || loaded.input.typeLabel}.docx`,
          typeMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          contenu: buffer,
          auteurId: action.createdBy,
        });
        prochainNumero += 1;
      } catch (error) {
        console.error(
          `[action-versions-fichier] échec de génération de la Version 1 (action ${action.id}), poursuite sans elle :`,
          error instanceof Error ? error.message : error
        );
      }
    }
  }

  versionsACreer.push({
    numero: prochainNumero,
    nomOriginal: parsed.data.nom,
    typeMime,
    contenu,
    auteurId: req.auth!.userId,
  });

  const versionsCreees = [];
  for (const v of versionsACreer) {
    const { nomFichier, tailleOctets } = await enregistrerFichier(action.dossierId, v.contenu);
    const version = await prisma.actionVersionFichier.create({
      data: {
        actionId: action.id,
        numero: v.numero,
        nomOriginal: v.nomOriginal,
        typeMime: v.typeMime,
        tailleOctets,
        nomFichier,
        auteurId: v.auteurId,
      },
      include: INCLUDE_STANDARD,
    });
    versionsCreees.push(version);
  }

  const versionUploadee = versionsCreees[versionsCreees.length - 1]!;
  await logAuditStep(
    action.id,
    "version_fichier_chargee",
    "succes",
    `Version ${versionUploadee.numero} chargée par ${req.auth!.userId}`
  );

  return res.status(201).json(versionsCreees);
});

async function chargerVersionAccessible(actionId: string, versionId: string, cabinetId: string) {
  const action = await chargerActionAccessible(actionId, cabinetId);
  if (!action) return null;
  const version = await prisma.actionVersionFichier.findFirst({
    where: { id: versionId, actionId: action.id },
  });
  if (!version) return null;
  return { action, version };
}

// Telechargement d'UNE version precise - toujours disponible, y compris
// pour une version anterieure a la version validee (jamais supprimee).
actionVersionsFichierRouter.get(
  "/api/actions/:id/versions-fichier/:versionId/telecharger",
  requireAuth,
  async (req, res) => {
    const loaded = await chargerVersionAccessible(req.params.id, req.params.versionId, req.auth!.cabinetId);
    if (!loaded) {
      return res.status(404).json({ error: "Version introuvable" });
    }

    let contenu: Buffer;
    try {
      contenu = await lireFichier(loaded.action.dossierId, loaded.version.nomFichier);
    } catch (error) {
      console.error(
        `[action-versions-fichier] échec de lecture de la version ${loaded.version.id} :`,
        error instanceof Error ? error.message : error
      );
      return res.status(500).json({ error: "Impossible de lire cette version (fichier illisible ou manquant sur disque)." });
    }

    res.setHeader("Content-Type", loaded.version.typeMime);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(loaded.version.nomOriginal)}"`);
    return res.send(contenu);
  }
);

// Valide UNE version precise - reservee a l'avocat/titulaire, jamais un
// collaborateur (meme regle que la validation des versions texte, voir
// routes/actionVersions.ts). Les versions restent TOUTES disponibles au
// telechargement apres validation, rien n'est jamais supprime.
actionVersionsFichierRouter.post(
  "/api/actions/:id/versions-fichier/:versionId/valider",
  requireAuth,
  async (req, res) => {
    if (req.auth!.role === "collaborateur") {
      return res.status(403).json({ error: "Seul un avocat du cabinet peut valider une version." });
    }

    const loaded = await chargerVersionAccessible(req.params.id, req.params.versionId, req.auth!.cabinetId);
    if (!loaded) {
      return res.status(404).json({ error: "Version introuvable" });
    }
    if (loaded.version.estVersionValidee) {
      return res.status(409).json({ error: "Cette version est déjà la version définitive." });
    }

    await prisma.$transaction([
      prisma.actionVersionFichier.updateMany({
        where: { actionId: loaded.action.id, estVersionValidee: true },
        data: { estVersionValidee: false },
      }),
      prisma.actionVersionFichier.update({ where: { id: loaded.version.id }, data: { estVersionValidee: true } }),
    ]);

    await logAuditStep(
      loaded.action.id,
      "version_fichier_validee",
      "succes",
      `Version ${loaded.version.numero} validée par ${req.auth!.userId}`
    );
    return res.json({ ok: true });
  }
);
