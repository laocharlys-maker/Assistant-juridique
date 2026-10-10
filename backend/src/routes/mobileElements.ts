import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { enregistrerFichier } from "../services/stockageDocuments";
import { lireFichierMobile, supprimerFichierMobile } from "../services/mobileSync/stockageMobile";
import * as courrierService from "../services/courriers/courrierService";
import { logMobileAudit } from "../services/mobileSync/mobileAudit";

/**
 * "Boîte de réception mobile" - écrans Prompt 2 (voir
 * docs/lot10/01-protocole.md pour le protocole d'appairage/transport,
 * Prompt 1). Routes de l'APPLICATION PRINCIPALE (127.0.0.1, cookie de
 * session standard) : les éléments ont déjà été reçus via /api/m/items
 * (routes/mobileSync.ts) au moment où ces routes sont utilisées.
 */
export const mobileElementsRouter = Router();

mobileElementsRouter.use("/api/mobile/elements", requireAuth);

function estTitulaire(role: string | undefined): boolean {
  return role === "titulaire";
}

const TYPE_MIME_AUDIO = "audio/aac"; // cf. Prompt 4 (hors perimetre ici) - placeholder coherent, le type reel sera fixe par Aurore Mobile.

const INCLUDE_LISTE = {
  device: { select: { id: true, nomDeclare: true, userId: true } },
  dossier: { select: { id: true, numeroDossier: true, nomAffaire: true } },
  marqueurs: true,
} as const;

const filtresSchema = z.object({
  statut: z.enum(["a_traiter", "traite", "tous"]).optional(),
  type: z.enum(["audio", "scan", "note"]).optional(),
});

mobileElementsRouter.get("/api/mobile/elements", async (req, res) => {
  const { auth } = req;
  const parsed = filtresSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Filtres invalides" });
  }

  const elements = await prisma.mobileItem.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      statut: { not: "recu" }, // "recu" = pas encore assemble cote serveur, invisible ici.
      ...(parsed.data.statut && parsed.data.statut !== "tous" ? { statut: parsed.data.statut } : {}),
      ...(parsed.data.type ? { type: parsed.data.type } : {}),
      ...(estTitulaire(auth!.role) ? {} : { device: { userId: auth!.userId } }),
    },
    include: INCLUDE_LISTE,
    orderBy: { recuLe: "desc" },
    take: 500,
  });

  return res.json(elements);
});

async function chargerElementAccessible(req: { params: { id: string }; auth?: { cabinetId: string; userId: string; role: string } }) {
  const element = await prisma.mobileItem.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
    include: INCLUDE_LISTE,
  });
  if (!element) return null;
  if (!estTitulaire(req.auth!.role) && element.device.userId !== req.auth!.userId) return null;
  return element;
}

mobileElementsRouter.get("/api/mobile/elements/:id", async (req, res) => {
  const element = await chargerElementAccessible(req);
  if (!element) return res.status(404).json({ error: "Élément introuvable" });
  return res.json(element);
});

const majSchema = z.object({
  dossierId: z.string().uuid().nullable().optional(),
  typeScan: z.enum(["piece", "decision", "courrier", "convocation", "autre"]).nullable().optional(),
  statut: z.enum(["a_traiter", "traite"]).optional(),
});

mobileElementsRouter.patch("/api/mobile/elements/:id", async (req, res) => {
  const element = await chargerElementAccessible(req);
  if (!element) return res.status(404).json({ error: "Élément introuvable" });
  const parsed = majSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  if (parsed.data.dossierId) {
    const dossier = await prisma.dossier.findFirst({ where: { id: parsed.data.dossierId, cabinetId: req.auth!.cabinetId } });
    if (!dossier) return res.status(404).json({ error: "Dossier introuvable" });
  }

  const misAJour = await prisma.mobileItem.update({
    where: { id: element.id },
    data: {
      ...(parsed.data.dossierId !== undefined ? { dossierId: parsed.data.dossierId } : {}),
      ...(parsed.data.typeScan !== undefined ? { typeScan: parsed.data.typeScan } : {}),
      ...(parsed.data.statut !== undefined ? { statut: parsed.data.statut } : {}),
    },
    include: INCLUDE_LISTE,
  });
  return res.json(misAJour);
});

/**
 * Lecture en flux de l'audio (Range HTTP, voir Prompt 2 objectif B) -
 * dechiffre a la volee cote serveur (le fichier reste toujours chiffre sur
 * disque, voir services/mobileSync/stockageMobile.ts). Dechiffrement
 * ENTIER en memoire puis decoupage - acceptable pour un audio de quelques
 * dizaines de Mo (cible 10-15 Mo/heure, voir Prompt 4), jamais un flux
 * dechiffre morceau par morceau (AES-GCM n'autorise pas un dechiffrement
 * partiel fiable sans relire tout le tag d'authentification final).
 */
mobileElementsRouter.get("/api/mobile/elements/:id/audio", async (req, res) => {
  const element = await chargerElementAccessible(req);
  if (!element || element.type !== "audio" || !element.cheminFichier) {
    return res.status(404).json({ error: "Audio introuvable" });
  }

  const contenu = await lireFichierMobile(element.deviceId, element.cheminFichier);
  const total = contenu.length;
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const debut = match && match[1] ? parseInt(match[1], 10) : 0;
    const fin = match && match[2] ? parseInt(match[2], 10) : total - 1;
    if (Number.isNaN(debut) || Number.isNaN(fin) || debut > fin || fin >= total) {
      res.status(416).set("Content-Range", `bytes */${total}`);
      return res.end();
    }
    res.status(206);
    res.set({
      "Content-Range": `bytes ${debut}-${fin}/${total}`,
      "Accept-Ranges": "bytes",
      "Content-Length": String(fin - debut + 1),
      "Content-Type": TYPE_MIME_AUDIO,
    });
    return res.end(contenu.subarray(debut, fin + 1));
  }

  res.set({ "Content-Type": TYPE_MIME_AUDIO, "Content-Length": String(total), "Accept-Ranges": "bytes" });
  return res.end(contenu);
});

/** "Rattachement au dossier en un clic" (scan) - copie le fichier vers le
 * stockage GED standard (source="mobile"), comme n'importe quelle piece de
 * dossier. Exige que dossierId soit deja renseigne sur l'item (via PATCH
 * ci-dessus) - jamais un dossier implicite. */
mobileElementsRouter.post("/api/mobile/elements/:id/document", async (req, res) => {
  const element = await chargerElementAccessible(req);
  if (!element || element.type !== "scan" || !element.cheminFichier) {
    return res.status(404).json({ error: "Élément introuvable ou non applicable" });
  }
  if (!element.dossierId) {
    return res.status(409).json({ error: "Rattache d'abord cet élément à un dossier." });
  }

  const contenu = await lireFichierMobile(element.deviceId, element.cheminFichier);
  const { nomFichier, tailleOctets } = await enregistrerFichier(element.dossierId, contenu);
  const document = await prisma.documentDossier.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: element.dossierId,
      nomOriginal: `scan-mobile-${element.id}.pdf`,
      typeMime: "application/pdf",
      tailleOctets,
      nomFichier,
      source: "mobile",
      uploadeParId: req.auth!.userId,
    },
  });

  await prisma.mobileItem.update({ where: { id: element.id }, data: { statut: "traite" } });
  await logMobileAudit(req.auth!.cabinetId, "element_classe_document", "succes", document.id, element.deviceId);
  return res.status(201).json({ documentId: document.id });
});

const creerCourrierSchema = z.object({
  objet: z.string().min(1),
  expediteur: z.string().min(1).optional(),
});

/** Scan de type "courrier" -> crée un vrai CourrierEntrant (statut initial
 * "recu", jamais choisi ici - même règle que la création normale d'un
 * courrier, voir services/courriers/courrierService.ts) avec le scan en
 * pièce jointe. */
mobileElementsRouter.post("/api/mobile/elements/:id/courrier", async (req, res) => {
  const element = await chargerElementAccessible(req);
  if (!element || element.type !== "scan" || !element.cheminFichier) {
    return res.status(404).json({ error: "Élément introuvable ou non applicable" });
  }
  const parsed = creerCourrierSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const courrier = await courrierService.creerCourrierEntrant(req.auth!.cabinetId, req.auth!.userId, {
    objet: parsed.data.objet,
    expediteur: parsed.data.expediteur,
    dossierId: element.dossierId ?? undefined,
  });

  const contenu = await lireFichierMobile(element.deviceId, element.cheminFichier);
  await courrierService.uploaderPieceCourrierEntrant(courrier.id, req.auth!.cabinetId, req.auth!.userId, {
    nom: `scan-mobile-${element.id}.pdf`,
    fichierDataUrl: `data:application/pdf;base64,${contenu.toString("base64")}`,
  });

  await prisma.mobileItem.update({ where: { id: element.id }, data: { statut: "traite" } });
  await logMobileAudit(req.auth!.cabinetId, "element_classe_courrier", "succes", courrier.id, element.deviceId);
  return res.status(201).json({ courrierId: courrier.id });
});

/** "Prochaine audience" détectée pendant l'enregistrement -> "Ajouter au
 * calendrier ?" (confirmation obligatoire, c'est CET appel qui fait foi -
 * jamais automatique). Crée un événement manuel (type "rdv" - "audience"
 * reste réservé à RoleAudience, voir docs/lot10/00-audit.md risque R4). */
mobileElementsRouter.post("/api/mobile/elements/:id/creer-evenement", async (req, res) => {
  const element = await chargerElementAccessible(req);
  if (!element || !element.prochaineAudience) {
    return res.status(409).json({ error: "Aucune date de prochaine audience sur cet élément." });
  }

  const evenement = await prisma.evenement.create({
    data: {
      cabinetId: req.auth!.cabinetId,
      dossierId: element.dossierId ?? undefined,
      type: "rdv",
      source: "manuel",
      titre: "Prochaine audience (repère Aurore Mobile)",
      dateDebut: element.prochaineAudience,
      createdById: req.auth!.userId,
      visibilite: "equipe",
    },
  });

  await logMobileAudit(req.auth!.cabinetId, "element_evenement_cree", "succes", evenement.id, element.deviceId);
  return res.status(201).json({ evenementId: evenement.id });
});

/** Aperçu d'un scan (image/PDF) avant classement - dechiffre a la volee,
 * jamais ecrit en clair sur disque. */
mobileElementsRouter.get("/api/mobile/elements/:id/apercu", async (req, res) => {
  const element = await chargerElementAccessible(req);
  if (!element || element.type !== "scan" || !element.cheminFichier) {
    return res.status(404).json({ error: "Aperçu indisponible" });
  }
  const contenu = await lireFichierMobile(element.deviceId, element.cheminFichier);
  res.set({ "Content-Type": "application/pdf", "Content-Length": String(contenu.length) });
  return res.end(contenu);
});

mobileElementsRouter.delete("/api/mobile/elements/:id", async (req, res) => {
  const element = await chargerElementAccessible(req);
  if (!element) return res.status(404).json({ error: "Élément introuvable" });
  if (element.statut !== "traite") {
    return res.status(409).json({ error: "Seul un élément déjà traité peut être supprimé ici." });
  }
  if (element.cheminFichier) {
    await supprimerFichierMobile(element.deviceId, element.cheminFichier).catch(() => undefined);
  }
  await prisma.mobileItem.delete({ where: { id: element.id } });
  await logMobileAudit(req.auth!.cabinetId, "element_supprime", "succes", undefined, element.deviceId);
  return res.json({ ok: true });
});

