import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { decoderEnveloppeAppareil, exigerAppareilAutorise } from "../middleware/mobileDeviceAuth";
import { mobilePairingLimiter } from "../middleware/rateLimit";
import { secretsEgaux, hacherSecret } from "../services/mobileSync/crypto";
import { logMobileAudit } from "../services/mobileSync/mobileAudit";
import { getAccessibleAvocatIds } from "../services/access";
import { ecrireChunk, assemblerEtVerifier } from "../services/mobileSync/stockageMobile";

/**
 * Routeur /api/m/* - monte UNIQUEMENT sur la deuxieme instance Express
 * isolee (voir mobileServer.ts), jamais sur l'app principale. Voir
 * docs/lot10/01-protocole.md pour le protocole complet.
 */
export const mobileSyncRouter = Router();

// -----------------------------------------------------------------------
// Appairage - seule route non authentifiee de tout ce routeur.
// -----------------------------------------------------------------------

const demanderSchema = z.object({
  pairingId: z.string().uuid(),
  secret: z.string().min(1),
  clePubliqueTelephone: z.string().min(1),
  nomAppareil: z.string().min(1).max(200),
});

mobileSyncRouter.post("/api/m/appairage/demander", mobilePairingLimiter, async (req, res) => {
  const parsed = demanderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }
  const { pairingId, secret, clePubliqueTelephone, nomAppareil } = parsed.data;

  const pairing = await prisma.mobilePairingSecret.findUnique({ where: { id: pairingId } });
  if (!pairing) {
    return res.status(404).json({ error: "Appairage introuvable" });
  }
  if (pairing.utilise || pairing.expireAt.getTime() < Date.now()) {
    await logMobileAudit(pairing.cabinetId, "appairage_expire_ou_deja_utilise", "erreur");
    return res.status(410).json({ error: "Ce QR a expiré ou a déjà été utilisé. Génère un nouveau QR." });
  }

  let secretBrut: Buffer;
  try {
    secretBrut = Buffer.from(secret, "base64");
  } catch {
    return res.status(400).json({ error: "Secret invalide" });
  }
  if (!secretsEgaux(hacherSecret(secretBrut), pairing.secretHash)) {
    await logMobileAudit(pairing.cabinetId, "appairage_secret_invalide", "erreur");
    return res.status(401).json({ error: "Secret d'appairage invalide" });
  }

  const [device] = await prisma.$transaction([
    prisma.mobileDevice.create({
      data: {
        cabinetId: pairing.cabinetId,
        userId: pairing.userId,
        nomDeclare: nomAppareil,
        clePublique: clePubliqueTelephone,
        statut: "en_attente",
      },
    }),
    prisma.mobilePairingSecret.update({ where: { id: pairing.id }, data: { utilise: true } }),
  ]);

  await logMobileAudit(pairing.cabinetId, "appairage_demande", "succes", nomAppareil, device.id);

  return res.status(201).json({ deviceId: device.id, statut: device.statut });
});

// -----------------------------------------------------------------------
// Toutes les routes suivantes exigent l'enveloppe chiffree.
// -----------------------------------------------------------------------

mobileSyncRouter.use("/api/m", (req, res, next) => {
  if (req.path === "/appairage/demander") return next();
  return decoderEnveloppeAppareil(req, res, next);
});

// Statut d'appairage - repond MEME si l'appareil n'est pas encore autorise
// (c'est justement ce que le telephone interroge en attendant).
// POST (jamais GET) bien que purement consultatif : l'enveloppe chiffree
// obligatoire (voir decoderEnveloppeAppareil ci-dessus) doit voyager dans
// un corps JSON, pas une query string - GET-avec-corps n'est pas fiable
// (certains clients/proxys l'ignorent).
mobileSyncRouter.post("/api/m/appairage/statut/:deviceId", async (req, res) => {
  if (req.mobileDevice!.id !== req.params.deviceId) {
    return res.status(403).json({ error: "Appareil non correspondant" });
  }
  return res.json({ statut: req.mobileDevice!.statut });
});

mobileSyncRouter.post("/api/m/ping", async (req, res) => {
  return res.json({ ok: true, cabinetId: req.mobileDevice!.cabinetId });
});

// À partir d'ici, l'appareil doit être autorisé.
mobileSyncRouter.use("/api/m/dossiers", exigerAppareilAutorise);
mobileSyncRouter.use("/api/m/items", exigerAppareilAutorise);

/**
 * Dossiers actifs de l'utilisateur lie a cet appareil - meme perimetre
 * d'acces que le reste de l'app (getAccessibleAvocatIds), jamais le
 * cabinet entier par defaut. "Prochaine audience" = plus proche
 * RoleAudience a venir pour ce dossier (pas un champ direct sur Dossier).
 */
mobileSyncRouter.post("/api/m/dossiers", async (req, res) => {
  const device = req.mobileDevice!;
  const user = await prisma.user.findUnique({ where: { id: device.userId } });
  if (!user) return res.status(404).json({ error: "Utilisateur introuvable" });

  const accessibleAvocatIds = await getAccessibleAvocatIds({ userId: user.id, cabinetId: user.cabinetId, role: user.role });

  const dossiers = await prisma.dossier.findMany({
    where: {
      cabinetId: device.cabinetId,
      estRecherche: false,
      archivedAt: null,
      supprimeLe: null,
      createdBy: { in: accessibleAvocatIds },
    },
    select: { id: true, numeroDossier: true, nomAffaire: true, nomClient: true },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  const prochainesAudiences = await prisma.roleAudience.findMany({
    where: { dossierId: { in: dossiers.map((d) => d.id) }, dateAudience: { gte: new Date() } },
    select: { dossierId: true, dateAudience: true },
    orderBy: { dateAudience: "asc" },
  });
  const prochaineParDossier = new Map<string, Date>();
  for (const a of prochainesAudiences) {
    if (a.dossierId && !prochaineParDossier.has(a.dossierId)) prochaineParDossier.set(a.dossierId, a.dateAudience);
  }

  return res.json(
    dossiers.map((d) => ({
      ...d,
      prochaineAudience: prochaineParDossier.get(d.id)?.toISOString() ?? null,
    }))
  );
});

// -----------------------------------------------------------------------
// Envoi d'un element par morceaux - voir protocole, et
// services/mobileSync/stockageMobile.ts pour le detail du stockage.
// -----------------------------------------------------------------------

const creerItemSchema = z.object({
  clientId: z.string().uuid(),
  type: z.enum(["audio", "scan", "note"]),
  dossierId: z.string().uuid().nullable().optional(),
  typeScan: z.enum(["piece", "decision", "courrier", "convocation", "autre"]).nullable().optional(),
  dureeSecondes: z.number().int().nonnegative().nullable().optional(),
  creeLeSurAppareil: z.string().datetime().nullable().optional(),
  prochaineAudience: z.string().datetime().nullable().optional(),
  noteTexte: z.string().nullable().optional(),
  nombreChunksAttendu: z.number().int().positive().max(10000),
  sha256Attendu: z.string().length(64),
});

/** Idempotent par (deviceId, clientId) - un renvoi du meme clientId (reprise
 * apres coupure) renvoie l'item existant au lieu d'en creer un second. */
mobileSyncRouter.post("/api/m/items", async (req, res) => {
  const device = req.mobileDevice!;
  const parsed = creerItemSchema.safeParse(req.mobilePayload);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }
  const data = parsed.data;

  if (data.dossierId) {
    const dossier = await prisma.dossier.findFirst({ where: { id: data.dossierId, cabinetId: device.cabinetId } });
    if (!dossier) return res.status(404).json({ error: "Dossier introuvable" });
  }

  const existant = await prisma.mobileItem.findUnique({
    where: { deviceId_clientId: { deviceId: device.id, clientId: data.clientId } },
  });
  if (existant) {
    return res.status(200).json({ itemId: existant.id, dejaExistant: true });
  }

  const item = await prisma.mobileItem.create({
    data: {
      cabinetId: device.cabinetId,
      deviceId: device.id,
      clientId: data.clientId,
      type: data.type,
      dossierId: data.dossierId ?? undefined,
      typeScan: data.typeScan ?? undefined,
      dureeSecondes: data.dureeSecondes ?? undefined,
      creeLeSurAppareil: data.creeLeSurAppareil ? new Date(data.creeLeSurAppareil) : undefined,
      prochaineAudience: data.prochaineAudience ? new Date(data.prochaineAudience) : undefined,
      noteTexte: data.noteTexte ?? undefined,
      statut: "recu",
    },
  });

  return res.status(201).json({ itemId: item.id, dejaExistant: false });
});

const chunkSchema = z.object({ contenuBase64: z.string().min(1) });

mobileSyncRouter.post("/api/m/items/:itemId/chunks/:numero", async (req, res) => {
  const device = req.mobileDevice!;
  const numero = Number(req.params.numero);
  if (!Number.isInteger(numero) || numero < 0) {
    return res.status(400).json({ error: "Numéro de morceau invalide" });
  }
  const parsed = chunkSchema.safeParse(req.mobilePayload);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const item = await prisma.mobileItem.findFirst({ where: { id: req.params.itemId, deviceId: device.id } });
  if (!item) return res.status(404).json({ error: "Élément introuvable" });
  if (item.statut !== "recu" || item.cheminFichier) {
    // Deja assemble (commit() deja passe) - un renvoi de chunk apres coup
    // n'est jamais applique, pour ne jamais corrompre un fichier deja
    // finalise. L'appelant doit considerer l'item comme termine.
    return res.status(409).json({ error: "Cet élément est déjà finalisé." });
  }

  let contenu: Buffer;
  try {
    contenu = Buffer.from(parsed.data.contenuBase64, "base64");
  } catch {
    return res.status(400).json({ error: "Contenu de morceau invalide" });
  }

  await ecrireChunk(device.id, item.clientId, numero, contenu);
  return res.json({ ok: true });
});

const commitSchema = z.object({
  nombreChunks: z.number().int().positive().max(10000),
  sha256: z.string().length(64),
});

mobileSyncRouter.post("/api/m/items/:itemId/commit", async (req, res) => {
  const device = req.mobileDevice!;
  const parsed = commitSchema.safeParse(req.mobilePayload);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const item = await prisma.mobileItem.findFirst({ where: { id: req.params.itemId, deviceId: device.id } });
  if (!item) return res.status(404).json({ error: "Élément introuvable" });
  if (item.cheminFichier) {
    // Deja commit - idempotent : renvoie simplement le reçu existant,
    // jamais une erreur (le telephone peut renvoyer ce commit apres une
    // coupure juste avant de recevoir la reponse initiale).
    return res.json({ ok: true, itemId: item.id, dejaConfirme: true });
  }

  try {
    const { nomFichier, tailleOctets } = await assemblerEtVerifier(
      device.id,
      item.clientId,
      parsed.data.nombreChunks,
      parsed.data.sha256
    );
    await prisma.mobileItem.update({
      where: { id: item.id },
      data: { cheminFichier: nomFichier, tailleOctets, sha256: parsed.data.sha256, statut: "a_traiter" },
    });
    await logMobileAudit(device.cabinetId, "element_recu", "succes", `type=${item.type}`, device.id);
    return res.json({ ok: true, itemId: item.id, dejaConfirme: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "erreur inconnue";
    await logMobileAudit(device.cabinetId, "element_echec_assemblage", "erreur", detail, device.id);
    return res.status(409).json({ error: "Assemblage impossible (morceau manquant ou intégrité invalide)." });
  }
});

// -----------------------------------------------------------------------
// Repères (Prompt 4, objectif B) - toujours envoyes APRES le commit de
// l'item (jamais avant : un repere sans item assemble n'aurait pas de sens).
// -----------------------------------------------------------------------

const marqueursSchema = z.object({
  marqueurs: z
    .array(
      z.object({
        type: z.enum(["prochaine_audience", "decision", "a_faire", "point_important"]),
        positionMs: z.number().int().nonnegative(),
        dateAudience: z.string().datetime().nullable().optional(),
      })
    )
    .max(500),
});

mobileSyncRouter.post("/api/m/items/:itemId/marqueurs", async (req, res) => {
  const device = req.mobileDevice!;
  const parsed = marqueursSchema.safeParse(req.mobilePayload);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const item = await prisma.mobileItem.findFirst({ where: { id: req.params.itemId, deviceId: device.id } });
  if (!item) return res.status(404).json({ error: "Élément introuvable" });

  if (parsed.data.marqueurs.length > 0) {
    await prisma.mobileMarker.createMany({
      data: parsed.data.marqueurs.map((m) => ({
        itemId: item.id,
        type: m.type,
        positionMs: m.positionMs,
        dateAudience: m.dateAudience ? new Date(m.dateAudience) : undefined,
      })),
    });
  }

  return res.status(201).json({ ok: true, nombre: parsed.data.marqueurs.length });
});

// -----------------------------------------------------------------------
// Statut (Prompt 4, objectif D) - le telephone interroge l'avancement de
// SES PROPRES elements deja envoyes ("Mes elements"). POST (jamais GET)
// pour la meme raison que /appairage/statut ci-dessus : le corps chiffre
// doit voyager dans un vrai corps JSON.
// -----------------------------------------------------------------------

const statutsSchema = z.object({ clientIds: z.array(z.string().uuid()).max(200) });

mobileSyncRouter.post("/api/m/items/statuts", async (req, res) => {
  const device = req.mobileDevice!;
  const parsed = statutsSchema.safeParse(req.mobilePayload);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide" });
  }

  const items = await prisma.mobileItem.findMany({
    where: { deviceId: device.id, clientId: { in: parsed.data.clientIds } },
    select: { clientId: true, statut: true },
  });

  const resultat: Record<string, "envoye" | "confirme"> = {};
  for (const item of items) {
    resultat[item.clientId] = item.statut === "traite" ? "confirme" : "envoye";
  }
  return res.json({ statuts: resultat });
});
