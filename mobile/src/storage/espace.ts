import { Paths } from "expo-file-system";

/**
 * Vérification d'espace disque (Prompt 6, objectif E, "disque presque
 * plein") - un enregistrement ou un scan qui démarre sans vérifier risque
 * d'échouer en cours d'écriture avec une erreur native cryptique plutôt
 * qu'un message clair avant même de commencer.
 */
const SEUIL_OCTETS = 100 * 1024 * 1024; // 100 Mo - large marge pour une heure d'audio (10-15 Mo visés).

export class EspaceDisqueInsuffisantError extends Error {
  constructor() {
    super("ESPACE_DISQUE_INSUFFISANT");
  }
}

export function verifierEspaceDisponible(): void {
  const disponible = Paths.availableDiskSpace;
  if (typeof disponible === "number" && disponible < SEUIL_OCTETS) {
    throw new EspaceDisqueInsuffisantError();
  }
}
