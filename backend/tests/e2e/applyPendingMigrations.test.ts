/**
 * Une installation EXISTANTE (cluster deja initialise avant l'ajout d'une
 * migration) doit recevoir automatiquement les tables/colonnes manquantes au
 * demarrage suivant, sans jamais planter et sans jamais perdre de donnees -
 * voir src/database/applyPendingMigrations.ts pour le contexte complet
 * (regression reelle constatee : facture_rappels_ignores absente d'une
 * installation portable mise a jour, "relation ... does not exist" au
 * premier appel touchant cette table).
 *
 * Simule un cluster "ancien" en supprimant une table normalement creee par
 * une migration recente d'un schema par ailleurs complet (startTestPostgres
 * applique deja la totalite du schema courant), plutot que de rejouer tout
 * l'historique de migrations depuis zero (impossible ici : les migrations de
 * ce projet ne couvrent que les evolutions APRES un squash de l'historique,
 * voir prisma/portable-init.sql).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { findPostgresBinDir, startTestPostgres, type TestPostgres } from "./helpers/testPostgres";

const pgAvailable = findPostgresBinDir() !== null;

describe.skipIf(!pgAvailable)("applyPendingMigrations - rattrapage d'une installation existante", () => {
  let pg: TestPostgres;
  let applyPendingMigrations: typeof import("../../src/database/applyPendingMigrations").applyPendingMigrations;
  let binDir: string;

  function psql(args: string[]): string {
    const bin = path.join(binDir, "psql.exe");
    return execFileSync(bin, ["-h", pg.host, "-p", String(pg.port), "-U", "e2e_superuser", "-d", pg.database, ...args], {
      stdio: "pipe",
    }).toString("utf8");
  }

  beforeAll(async () => {
    if (!pgAvailable) return;
    binDir = findPostgresBinDir()!;
    pg = (await startTestPostgres("apply-pending-migrations"))!;

    // Simule un cluster mis a jour depuis AVANT la migration
    // facture_rappels_ignores : supprime la table (le reste du schema,
    // deja applique par startTestPostgres, reste intact).
    psql(["-v", "ON_ERROR_STOP=1", "-c", 'DROP TABLE IF EXISTS "facture_rappels_ignores" CASCADE;']);

    ({ applyPendingMigrations } = await import("../../src/database/applyPendingMigrations"));
  });

  afterAll(() => {
    if (!pgAvailable) return;
    pg?.stop();
  });

  const fakeCredentials = {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    host: "127.0.0.1",
    port: 0,
    database: "",
    superuser: "e2e_superuser",
    superuserPassword: "",
    appUser: "e2e_superuser",
    appUserPassword: "",
  };

  it("recree la table manquante et l'enregistre, sans toucher au reste du schema", async () => {
    const before = psql(["-t", "-A", "-c", "SELECT to_regclass('public.facture_rappels_ignores');"]).trim();
    expect(before).toBe("");

    await applyPendingMigrations({
      host: pg.host,
      port: pg.port,
      database: pg.database,
      credentials: { ...fakeCredentials, host: pg.host, port: pg.port, database: pg.database },
      psqlPath: path.join(binDir, "psql.exe"),
    });

    const after = psql(["-t", "-A", "-c", "SELECT to_regclass('public.facture_rappels_ignores');"]).trim();
    expect(after).toBe("facture_rappels_ignores");

    // Une table pre-existante (non supprimee) n'a pas ete touchee/recreee.
    const usersStillThere = psql(["-t", "-A", "-c", "SELECT to_regclass('public.users');"]).trim();
    expect(usersStillThere).toBe("users");
  });

  it("enregistre toutes les migrations comme appliquees (les autres via 'already exists', tolere sans erreur)", async () => {
    const rows = psql(["-t", "-A", "-c", 'SELECT count(*) FROM "_aurore_schema_migrations";']).trim();
    expect(Number(rows)).toBeGreaterThan(1);
  });

  it("second passage : no-op rapide, ne re-echoue jamais", async () => {
    await expect(
      applyPendingMigrations({
        host: pg.host,
        port: pg.port,
        database: pg.database,
        credentials: { ...fakeCredentials, host: pg.host, port: pg.port, database: pg.database },
        psqlPath: path.join(binDir, "psql.exe"),
      })
    ).resolves.toBeUndefined();
  });
});
