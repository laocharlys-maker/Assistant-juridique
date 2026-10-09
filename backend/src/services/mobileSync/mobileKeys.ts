import { prisma } from "../../lib/prisma";
import { encryptField, decryptField } from "../../security/encryptionAtRest";
import {
  genererPaireClesX25519,
  exporterClePriveeBase64,
  importerClePriveeBase64,
  importerClePubliqueBase64,
} from "./crypto";

/**
 * Resout la paire de cles X25519 permanente du cabinet (genere a la toute
 * premiere demande si absente) - voir docs/lot10/01-protocole.md section 2.
 *
 * La cle privee est chiffree au repos EXPLICITEMENT ici via
 * encryptField()/decryptField() (meme primitive que les champs textuels
 * chiffres geres par l'extension Prisma, security/prismaEncryption.ts) -
 * PAS via cette extension elle-meme : Cabinet est deja un point de passage
 * pour la quasi-totalite des relations du schema (verifie : l'ajouter a
 * ENCRYPTED_FIELDS_BY_MODEL n'elargit pas le perimetre de dechiffrement
 * automatique, deja maximal aujourd'hui via Action -> Dossier -> Cabinet -
 * mais pour rester prudent et explicite sur un champ aussi sensible qu'une
 * cle privee, le chiffrement/dechiffrement est appele directement ici,
 * sans dependre du comportement implicite de l'extension).
 */
export async function resoudreClesCabinet(
  cabinetId: string
): Promise<{ clePubliqueBase64: string; clePriveeKeyObject: import("node:crypto").KeyObject }> {
  const cabinet = await prisma.cabinet.findUnique({
    where: { id: cabinetId },
    select: { mobileServerClePublique: true, mobileServerClePrivee: true },
  });
  if (!cabinet) {
    throw new Error("CABINET_INTROUVABLE");
  }

  if (cabinet.mobileServerClePublique && cabinet.mobileServerClePrivee) {
    const clePriveeBase64 = decryptField(cabinet.mobileServerClePrivee);
    if (!clePriveeBase64) {
      throw new Error("CLE_PRIVEE_CABINET_ILLISIBLE");
    }
    return {
      clePubliqueBase64: cabinet.mobileServerClePublique,
      clePriveeKeyObject: importerClePriveeBase64(clePriveeBase64),
    };
  }

  // Premiere activation : genere une seule fois, jamais regenere ensuite
  // par ce chemin (une regeneration explicite invaliderait tous les
  // appareils deja appaires - action destructrice reservee a un futur
  // bouton dedie avec confirmation, pas a ce code de resolution passive).
  const paire = genererPaireClesX25519();
  const clePriveeBase64 = exporterClePriveeBase64(paire.clePriveeKeyObject);
  await prisma.cabinet.update({
    where: { id: cabinetId },
    data: {
      mobileServerClePublique: paire.clePubliqueBase64,
      mobileServerClePrivee: encryptField(clePriveeBase64) ?? undefined,
    },
  });
  return { clePubliqueBase64: paire.clePubliqueBase64, clePriveeKeyObject: paire.clePriveeKeyObject };
}

/** Pratique pour les points d'appel qui n'ont besoin que de verifier/calculer
 * une cle partagee sans manipuler la paire complete. */
export function importerClePubliqueTelephone(base64: string) {
  return importerClePubliqueBase64(base64);
}
