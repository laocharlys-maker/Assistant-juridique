import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import { requireAdmin } from "../middleware/roles";
import { genererSecretAppairage } from "../services/mobileSync/crypto";
import { resoudreClesCabinet } from "../services/mobileSync/mobileKeys";
import { listerAdressesLocales } from "../services/mobileSync/reseauMobile";
import { ouvrirPortPareFeu } from "../services/mobileSync/firewall";
import { logMobileAudit } from "../services/mobileSync/mobileAudit";

/**
 * Routes de l'APPLICATION PRINCIPALE (127.0.0.1, authentifiees par cookie
 * de session comme le reste de l'app - requireAuth standard, PAS le
 * protocole d'appairage) pour gerer les appareils mobiles et le reglage
 * "Synchronisation mobile" - voir docs/lot10/01-protocole.md.
 *
 * Distinct de routes/mobileSync.ts (routeur /api/m/*, monte sur la
 * DEUXIEME instance Express isolee, voir mobileServer.ts).
 */
export const mobileAppareilsRouter = Router();

const DUREE_PAIRING_MINUTES = 5;

mobileAppareilsRouter.use("/api/mobile", requireAuth);

function estTitulaire(role: string | undefined): boolean {
  return role === "titulaire";
}

// Genere un QR d'appairage POUR SOI-MEME - un appareil est toujours lie a
// l'utilisateur qui genere le QR (jamais un choix fait par le telephone).
mobileAppareilsRouter.post("/api/mobile/appareils/qr", async (req, res) => {
  const { auth } = req;
  const cabinet = await prisma.cabinet.findUnique({
    where: { id: auth!.cabinetId },
    select: { mobileSyncActif: true, mobileSyncInterface: true, mobileSyncPort: true },
  });
  if (!cabinet?.mobileSyncActif) {
    return res.status(409).json({ error: "La synchronisation mobile n'est pas activée pour ce cabinet." });
  }

  const { clePubliqueBase64 } = await resoudreClesCabinet(auth!.cabinetId);
  const { secretBase64, secretHash } = genererSecretAppairage();
  const expireAt = new Date(Date.now() + DUREE_PAIRING_MINUTES * 60 * 1000);

  const pairing = await prisma.mobilePairingSecret.create({
    data: { cabinetId: auth!.cabinetId, userId: auth!.userId, secretHash, expireAt },
  });

  const adresses = listerAdressesLocales(cabinet.mobileSyncInterface).map((ip) => `${ip}:${cabinet.mobileSyncPort}`);

  const contenuQr = JSON.stringify({
    v: 1,
    pairingId: pairing.id,
    secret: secretBase64,
    clePubliquePC: clePubliqueBase64,
    adresses,
  });
  // PNG en data URL - rendu 100% local (aucun appel reseau, meme principe
  // offline-first que le reste de l'app), affiche tel quel dans un <img>
  // cote ecran (Prompt 2).
  const qrDataUrl = await QRCode.toDataURL(contenuQr, { errorCorrectionLevel: "M", margin: 1, scale: 6 });

  return res.status(201).json({
    pairingId: pairing.id,
    secret: secretBase64,
    clePubliquePC: clePubliqueBase64,
    adresses,
    expireAt: expireAt.toISOString(),
    qrDataUrl,
  });
});

// Liste des appareils : le titulaire voit tout le cabinet, un avocat/
// collaborateur ne voit que les siens (meme principe que "Mes dossiers"
// vs "Dossiers du cabinet" ailleurs dans l'app).
mobileAppareilsRouter.get("/api/mobile/appareils", async (req, res) => {
  const { auth } = req;
  const appareils = await prisma.mobileDevice.findMany({
    where: {
      cabinetId: auth!.cabinetId,
      ...(estTitulaire(auth!.role) ? {} : { userId: auth!.userId }),
    },
    select: {
      id: true,
      nomDeclare: true,
      statut: true,
      createdAt: true,
      autoriseAt: true,
      derniereConnexionAt: true,
      user: { select: { id: true, nom: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return res.json(appareils);
});

async function chargerAppareilGerable(req: { params: { id: string }; auth?: { cabinetId: string; userId: string; role: string } }) {
  const appareil = await prisma.mobileDevice.findFirst({
    where: { id: req.params.id, cabinetId: req.auth!.cabinetId },
  });
  if (!appareil) return null;
  if (!estTitulaire(req.auth!.role) && appareil.userId !== req.auth!.userId) return null;
  return appareil;
}

mobileAppareilsRouter.patch("/api/mobile/appareils/:id/autoriser", async (req, res) => {
  const appareil = await chargerAppareilGerable(req);
  if (!appareil) return res.status(404).json({ error: "Appareil introuvable" });
  if (appareil.statut !== "en_attente") {
    return res.status(409).json({ error: "Cet appareil n'est pas en attente d'autorisation." });
  }
  await prisma.mobileDevice.update({ where: { id: appareil.id }, data: { statut: "autorise", autoriseAt: new Date() } });
  await logMobileAudit(req.auth!.cabinetId, "appairage_autorise", "succes", `Autorisé par ${req.auth!.userId}`, appareil.id);
  return res.json({ ok: true });
});

mobileAppareilsRouter.patch("/api/mobile/appareils/:id/refuser", async (req, res) => {
  const appareil = await chargerAppareilGerable(req);
  if (!appareil) return res.status(404).json({ error: "Appareil introuvable" });
  await prisma.mobileDevice.update({ where: { id: appareil.id }, data: { statut: "revoque", revoqueAt: new Date() } });
  await logMobileAudit(req.auth!.cabinetId, "appairage_refuse", "succes", `Refusé par ${req.auth!.userId}`, appareil.id);
  return res.json({ ok: true });
});

mobileAppareilsRouter.patch("/api/mobile/appareils/:id/revoquer", async (req, res) => {
  const appareil = await chargerAppareilGerable(req);
  if (!appareil) return res.status(404).json({ error: "Appareil introuvable" });
  await prisma.mobileDevice.update({ where: { id: appareil.id }, data: { statut: "revoque", revoqueAt: new Date() } });
  await logMobileAudit(req.auth!.cabinetId, "appareil_revoque", "succes", `Révoqué par ${req.auth!.userId}`, appareil.id);
  return res.json({ ok: true });
});

// Reglages : reserves au titulaire (activation, interface, port) - meme
// perimetre que les autres reglages sensibles du cabinet (taux horaire,
// activation de compte...).
mobileAppareilsRouter.get("/api/mobile/reglages", requireAdmin, async (req, res) => {
  const cabinet = await prisma.cabinet.findUnique({
    where: { id: req.auth!.cabinetId },
    select: {
      mobileSyncActif: true,
      mobileSyncInterface: true,
      mobileSyncPort: true,
      mobileConservationAudioJours: true,
    },
  });
  return res.json(cabinet);
});

const reglagesSchema = z.object({
  actif: z.boolean(),
  interface: z.string().nullable().optional(),
  port: z.number().int().min(1024).max(65535).optional(),
  // Conservation de l'audio (Prompt 2) - null/absent = manuelle (jamais de
  // suppression automatique, valeur par defaut).
  conservationAudioJours: z.union([z.literal(7), z.literal(30), z.literal(90)]).nullable().optional(),
});

mobileAppareilsRouter.patch("/api/mobile/reglages", requireAdmin, async (req, res) => {
  const parsed = reglagesSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Requête invalide", details: parsed.error.issues });
  }

  const cabinet = await prisma.cabinet.update({
    where: { id: req.auth!.cabinetId },
    data: {
      mobileSyncActif: parsed.data.actif,
      ...(parsed.data.interface !== undefined ? { mobileSyncInterface: parsed.data.interface } : {}),
      ...(parsed.data.port !== undefined ? { mobileSyncPort: parsed.data.port } : {}),
      ...(parsed.data.conservationAudioJours !== undefined
        ? { mobileConservationAudioJours: parsed.data.conservationAudioJours }
        : {}),
    },
    select: {
      mobileSyncActif: true,
      mobileSyncInterface: true,
      mobileSyncPort: true,
      mobileConservationAudioJours: true,
    },
  });

  let pareFeu: { ok: boolean; message: string } | null = null;
  if (parsed.data.actif) {
    // Genere la paire de cles permanente des l'activation si elle n'existe
    // pas encore (plutot qu'a la premiere demande de QR) - evite un delai
    // supplementaire perceptible au premier appairage.
    await resoudreClesCabinet(req.auth!.cabinetId);
    pareFeu = await ouvrirPortPareFeu(cabinet.mobileSyncPort);
    await logMobileAudit(
      req.auth!.cabinetId,
      "reglage_active",
      pareFeu.ok ? "succes" : "erreur",
      pareFeu.message
    );
  } else {
    await logMobileAudit(req.auth!.cabinetId, "reglage_desactive", "succes");
  }

  // Le serveur mobile n'est (re)demarre qu'au lancement d'Aurore (voir
  // mobileServer.ts) - meme principe deja accepte pour le changement de
  // mode de deploiement (routes/networkInfo.ts).
  return res.json({ ...cabinet, pareFeu, redemarrageRequis: true });
});
