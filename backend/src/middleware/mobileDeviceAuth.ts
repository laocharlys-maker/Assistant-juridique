import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { dechiffrerEnveloppe, EnveloppeInvalideError, calculerCleParGesee, importerClePubliqueBase64 } from "../services/mobileSync/crypto";
import { resoudreClesCabinet } from "../services/mobileSync/mobileKeys";
import { logMobileAudit } from "../services/mobileSync/mobileAudit";

/**
 * Authentification des requetes /api/m/* APRES l'appairage - voir
 * docs/lot10/01-protocole.md section 4. Pas de jeton porteur : la cle
 * partagee SK (ECDH + HKDF) est recalculee a chaque requete a partir de la
 * cle privee permanente du cabinet et de la cle publique de l'appareil
 * (MobileDevice.clePublique) - jamais stockee, jamais transmise.
 *
 * S'applique a TOUTES les routes /api/m/* sauf POST /api/m/appairage/demander
 * (seule route non authentifiee, protegee par le secret d'appairage a la
 * place - voir routes/mobileSync.ts).
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mobileDevice?: { id: string; cabinetId: string; userId: string; statut: string; clePublique: string };
      mobilePayload?: unknown;
    }
  }
}

const ENVELOPPE_HORODATAGE_TOLERANCE_MS = 5 * 60 * 1000;

const enveloppeSchema = z.object({
  deviceId: z.string().uuid(),
  compteur: z.number().int().nonnegative(),
  horodatage: z.number(),
  enveloppe: z.string().min(1),
});

export async function decoderEnveloppeAppareil(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = enveloppeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Requête invalide" });
    return;
  }
  const { deviceId, compteur, horodatage, enveloppe } = parsed.data;

  const device = await prisma.mobileDevice.findUnique({ where: { id: deviceId } });
  if (!device) {
    res.status(401).json({ error: "Appareil inconnu" });
    return;
  }

  if (Math.abs(Date.now() - horodatage) > ENVELOPPE_HORODATAGE_TOLERANCE_MS) {
    await logMobileAudit(
      device.cabinetId,
      "horloge_desynchronisee",
      "erreur",
      `ecartMs=${Date.now() - horodatage},compteur=${compteur},chemin=${req.path}`,
      device.id
    );
    res.status(401).json({ error: "Horloge de l'appareil désynchronisée (plus de 5 minutes d'écart)." });
    return;
  }

  if (device.dernierCompteur !== null && compteur <= device.dernierCompteur) {
    await logMobileAudit(device.cabinetId, "requete_rejouee", "erreur", `compteur=${compteur}`, device.id);
    res.status(409).json({ error: "Requête rejouée ou hors séquence." });
    return;
  }

  try {
    const { clePriveeKeyObject } = await resoudreClesCabinet(device.cabinetId);
    const sk = calculerCleParGesee(clePriveeKeyObject, importerClePubliqueBase64(device.clePublique), device.id);
    const aad = Buffer.from(JSON.stringify({ deviceId, compteur, horodatage }));
    const plaintext = dechiffrerEnveloppe(sk, enveloppe, aad);
    req.mobilePayload = plaintext.length > 0 ? JSON.parse(plaintext.toString("utf8")) : {};
  } catch (error) {
    const detail = error instanceof EnveloppeInvalideError ? "enveloppe_invalide" : "erreur_interne";
    await logMobileAudit(device.cabinetId, "echec_authentification", "erreur", detail, device.id);
    res.status(401).json({ error: "Authentification invalide" });
    return;
  }

  // Compteur avance SEULEMENT apres dechiffrement reussi - une enveloppe
  // invalide ne doit jamais consommer un numero de sequence legitime.
  await prisma.mobileDevice.update({
    where: { id: device.id },
    data: { dernierCompteur: compteur, derniereConnexionAt: new Date() },
  });

  req.mobileDevice = device;
  next();
}

/** A appliquer EN PLUS de decoderEnveloppeAppareil sur toute route qui
 * exige un appareil deja autorise par le PC (/m/dossiers, /m/items...) -
 * PAS sur /m/appairage/statut ni /m/ping, qui doivent repondre meme en
 * attente/revoque (statut lui-meme, ou simple test de portee). */
export function exigerAppareilAutorise(req: Request, res: Response, next: NextFunction): void {
  if (req.mobileDevice?.statut !== "autorise") {
    res.status(403).json({ error: "Cet appareil n'est pas autorisé." });
    return;
  }
  next();
}
