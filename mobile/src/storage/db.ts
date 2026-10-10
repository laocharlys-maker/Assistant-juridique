import * as SQLite from "expo-sqlite";
import { chiffrerTexte, dechiffrerTexte } from "../vault/vault";

/**
 * Cache local chiffré des dossiers (Prompt 3, objectif F) - consultable
 * hors ligne, avec la date de dernière mise à jour. Choix explicite :
 * chaque dossier est stocké comme UN SEUL champ chiffré (JSON complet),
 * jamais colonne par colonne en clair - même principe de chiffrement
 * applicatif que vault/vault.ts (pas de SQLCipher, voir sa justification).
 * Seul `id` reste en clair (nécessaire pour les opérations SQL elles-mêmes -
 * ni confidentiel, ni exploitable seul).
 */

export interface DossierCache {
  id: string;
  numeroDossier: string;
  nomAffaire: string;
  nomClient: string;
  prochaineAudience: string | null;
}

export type StatutElementLocal = "en_attente" | "envoye" | "confirme";

export interface MarqueurLocal {
  type: "prochaine_audience" | "decision" | "a_faire" | "point_important";
  positionMs: number;
  dateAudience: string | null;
}

/** Élément local (Prompt 4, objectifs A-D) - un enregistrement audio en
 * attente d'envoi, de confirmation ou de classement. `clientId` est l'id
 * stable généré par le téléphone, identique à celui envoyé au serveur
 * (idempotence, voir backend/src/routes/mobileSync.ts). */
export interface ElementLocal {
  clientId: string;
  type: "audio";
  statut: StatutElementLocal;
  dossierId: string | null;
  dureeSecondes: number;
  creeLe: string;
  nombreSegments: number;
  marqueurs: MarqueurLocal[];
  noteTexte: string | null;
}

let db: SQLite.SQLiteDatabase | null = null;

async function obtenirDb(): Promise<SQLite.SQLiteDatabase> {
  if (db) return db;
  db = await SQLite.openDatabaseAsync("aurore-mobile.db");
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS dossiers_cache (
      id TEXT PRIMARY KEY NOT NULL,
      donnees_chiffrees TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      cle TEXT PRIMARY KEY NOT NULL,
      valeur TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS elements_locaux (
      client_id TEXT PRIMARY KEY NOT NULL,
      statut TEXT NOT NULL,
      donnees_chiffrees TEXT NOT NULL
    );
  `);
  return db;
}

/** Remplace entièrement le cache par la liste reçue du serveur - toujours
 * la liste COMPLÈTE (voir POST /api/m/dossiers côté serveur), jamais un
 * patch incrémental : une suppression côté serveur doit disparaître ici
 * aussi, ce qu'un simple upsert ne garantirait pas. */
export async function remplacerCacheDossiers(dossiers: DossierCache[]): Promise<void> {
  const base = await obtenirDb();
  await base.withTransactionAsync(async () => {
    await base.runAsync("DELETE FROM dossiers_cache");
    for (const dossier of dossiers) {
      const chiffre = await chiffrerTexte(JSON.stringify(dossier));
      await base.runAsync("INSERT INTO dossiers_cache (id, donnees_chiffrees) VALUES (?, ?)", [dossier.id, chiffre]);
    }
    await base.runAsync("INSERT OR REPLACE INTO meta (cle, valeur) VALUES ('dossiers_derniere_maj', ?)", [
      String(Date.now()),
    ]);
  });
}

export async function listerDossiersCache(): Promise<DossierCache[]> {
  const base = await obtenirDb();
  const lignes = await base.getAllAsync<{ id: string; donnees_chiffrees: string }>(
    "SELECT id, donnees_chiffrees FROM dossiers_cache ORDER BY id"
  );
  const dossiers: DossierCache[] = [];
  for (const ligne of lignes) {
    try {
      dossiers.push(JSON.parse(await dechiffrerTexte(ligne.donnees_chiffrees)) as DossierCache);
    } catch {
      // Ligne illisible (coffre change entre-temps, corruption...) - jamais
      // bloquant pour les autres dossiers, juste ignoree.
    }
  }
  return dossiers;
}

export async function dateDerniereMajDossiers(): Promise<Date | null> {
  const base = await obtenirDb();
  const ligne = await base.getFirstAsync<{ valeur: string }>(
    "SELECT valeur FROM meta WHERE cle = 'dossiers_derniere_maj'"
  );
  return ligne ? new Date(Number(ligne.valeur)) : null;
}

export async function enregistrerElementLocal(element: ElementLocal): Promise<void> {
  const base = await obtenirDb();
  const chiffre = await chiffrerTexte(JSON.stringify(element));
  await base.runAsync("INSERT OR REPLACE INTO elements_locaux (client_id, statut, donnees_chiffrees) VALUES (?, ?, ?)", [
    element.clientId,
    element.statut,
    chiffre,
  ]);
}

export async function listerElementsLocaux(): Promise<ElementLocal[]> {
  const base = await obtenirDb();
  const lignes = await base.getAllAsync<{ client_id: string; donnees_chiffrees: string }>(
    "SELECT client_id, donnees_chiffrees FROM elements_locaux ORDER BY client_id DESC"
  );
  const elements: ElementLocal[] = [];
  for (const ligne of lignes) {
    try {
      elements.push(JSON.parse(await dechiffrerTexte(ligne.donnees_chiffrees)) as ElementLocal);
    } catch {
      // Ligne illisible - jamais bloquant pour les autres elements.
    }
  }
  return elements;
}

export async function majStatutElementLocal(clientId: string, statut: StatutElementLocal): Promise<void> {
  const base = await obtenirDb();
  const ligne = await base.getFirstAsync<{ donnees_chiffrees: string }>(
    "SELECT donnees_chiffrees FROM elements_locaux WHERE client_id = ?",
    [clientId]
  );
  if (!ligne) return;
  const element = JSON.parse(await dechiffrerTexte(ligne.donnees_chiffrees)) as ElementLocal;
  element.statut = statut;
  await enregistrerElementLocal(element);
}

export async function supprimerElementLocal(clientId: string): Promise<void> {
  const base = await obtenirDb();
  await base.runAsync("DELETE FROM elements_locaux WHERE client_id = ?", [clientId]);
}

/** Pour les tests uniquement - force une nouvelle connexion/fichier au
 * prochain appel (chaque test doit repartir d'une base propre). */
export function _reinitialiserDbPourTests(): void {
  db = null;
}
