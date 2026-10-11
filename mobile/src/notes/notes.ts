import * as Crypto from "expo-crypto";
import {
  enregistrerElementLocal,
  obtenirElementLocal,
  type ElementLocal,
  type StatutElementLocal,
} from "../storage/db";

/**
 * Note texte rapide (Prompt 5, objectif C) - soit un nouvel élément
 * autonome (rattaché à un dossier ou "à classer"), soit jointe à un élément
 * déjà existant (audio ou scan pas encore envoyé) en complétant son champ
 * `noteTexte` - même champ, même cycle de statuts, jamais un type d'élément
 * séparé pour "une note sur un autre élément".
 */

export class NoteVideError extends Error {
  constructor() {
    super("NOTE_VIDE");
  }
}

export async function creerNoteLocale(texte: string, dossierId: string | null): Promise<ElementLocal> {
  const texteNettoye = texte.trim();
  if (!texteNettoye) throw new NoteVideError();

  const element: ElementLocal = {
    clientId: Crypto.randomUUID(),
    type: "note",
    statut: "en_attente" as StatutElementLocal,
    dossierId,
    creeLe: new Date().toISOString(),
    noteTexte: texteNettoye,
    derniereErreurEnvoi: null,
  };
  await enregistrerElementLocal(element);
  return element;
}

export class ElementIntrouvableError extends Error {
  constructor() {
    super("ELEMENT_INTROUVABLE");
  }
}

export class ElementDejaEnvoyeError extends Error {
  constructor() {
    super("ELEMENT_DEJA_ENVOYE");
  }
}

/** Ajoute/remplace la note texte d'un élément déjà créé (audio ou scan),
 * tant qu'il n'a pas encore été envoyé - après l'envoi, le serveur a déjà
 * sa propre copie du champ, le modifier localement ne servirait à rien. */
export async function joindreNoteAElement(clientId: string, texte: string): Promise<ElementLocal> {
  const texteNettoye = texte.trim();
  if (!texteNettoye) throw new NoteVideError();

  const element = await obtenirElementLocal(clientId);
  if (!element) throw new ElementIntrouvableError();
  if (element.statut !== "en_attente") throw new ElementDejaEnvoyeError();

  element.noteTexte = texteNettoye;
  await enregistrerElementLocal(element);
  return element;
}
