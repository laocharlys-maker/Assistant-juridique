import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/**
 * Bootstrap d'un cluster PostgreSQL jetable pour les tests de bout en bout
 * (Lot 7) - jamais une base contenant de vraies donnees (voir
 * README-LOT7.md). Reutilise le PostgreSQL deja installe sur la machine de
 * developpement/CI (comme empiriquement pour tous les lots precedents)
 * plutot que les binaires portables du Lot 2 (qui exigent un telechargement
 * prealable, `npm run postgres:download-binaries`, absent d'un clone frais)
 * - se degrade proprement (retourne null, le test suite doit alors ignorer
 * les tests plutot qu'echouer) si aucun PostgreSQL n'est trouve.
 *
 * Schema applique SANS l'extension `vector` (pgvector ne peut pas etre
 * compile sans Visual Studio Build Tools - meme limite documentee que les
 * Lots 2/2bis/3/5/6) : les tests de bout en bout de ce lot ne portent pas
 * sur la recherche de jurisprudence.
 */

export interface TestPostgres {
  databaseUrl: string;
  host: string;
  port: number;
  database: string;
  dataDir: string;
  stop: () => void;
}

function candidateBinDirs(): string[] {
  const candidates: string[] = [];
  if (process.env.E2E_PG_BIN_DIR) candidates.push(process.env.E2E_PG_BIN_DIR);
  if (process.platform === "win32") {
    const base = "C:\\Program Files\\PostgreSQL";
    if (fs.existsSync(base)) {
      const versions = fs
        .readdirSync(base)
        .filter((name) => /^\d+$/.test(name))
        .sort((a, b) => Number(b) - Number(a)); // version la plus recente d'abord
      for (const version of versions) candidates.push(path.join(base, version, "bin"));
    }
  }
  candidates.push(""); // "" = tente sur le PATH directement
  return candidates;
}

/** Retourne le dossier bin/ a utiliser, ou null si aucun PostgreSQL
 * exploitable n'a ete trouve (initdb/pg_ctl/psql/createdb tous requis). */
export function findPostgresBinDir(): string | null {
  for (const dir of candidateBinDirs()) {
    const initdb = dir ? path.join(dir, "initdb.exe") : "initdb";
    try {
      const result = spawnSync(initdb, ["--version"], { stdio: "pipe" });
      if (result.status === 0) return dir;
    } catch {
      // essaie le candidat suivant
    }
  }
  return null;
}

/**
 * Trouve un port TCP reellement libre en laissant l'OS en attribuer un
 * (bind sur le port 0), plutot qu'un port fixe/derive d'un compteur - les
 * trois suites e2e tournent chacune dans leur propre worker vitest (donc
 * leur propre instance de ce module, chacune avec SON compteur reinitialise
 * a zero) : un port fixe entrainerait une collision reelle des qu'on lance
 * plusieurs suites en parallele (`npm run test:e2e`) - constate
 * empiriquement (echec de `pg_ctl start`, port deja utilise par une autre
 * suite).
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Impossible de determiner un port libre"));
      });
    });
  });
}

export async function startTestPostgres(labelSuffix: string): Promise<TestPostgres | null> {
  const resolvedBinDir = findPostgresBinDir();
  if (resolvedBinDir === null) return null;

  const bin = (name: string) => (resolvedBinDir ? path.join(resolvedBinDir, `${name}.exe`) : name);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `aurore-e2e-pg-${labelSuffix}-`));
  const port = await getFreePort();
  const database = `aurore_e2e_${labelSuffix}`;

  execFileSync(bin("initdb"), ["-D", dataDir, "-U", "e2e_superuser", "-A", "trust", "-E", "UTF8", "--locale=C"], {
    stdio: "pipe",
  });
  // stdio: "ignore" - PAS "pipe" : `pg_ctl start` demonise postgres.exe et
  // ses processus auxiliaires (checkpointer, bgwriter...), qui heritent
  // des pipes et ne les ferment jamais - execFileSync avec stdio "pipe"
  // attend alors indefiniment que les pipes se ferment et ne revient
  // JAMAIS (meme bug deja rencontre et documente au Lot 2, voir
  // database/postgresPortable.ts et README-LOT2.md).
  execFileSync(bin("pg_ctl"), ["start", "-D", dataDir, "-l", path.join(dataDir, "pg.log"), "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "-w"], {
    stdio: "ignore",
  });

  try {
    execFileSync(bin("createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", "e2e_superuser", database], {
      stdio: "pipe",
    });

    const schemaSql = buildVectorFreeSchemaSql();
    const schemaPath = path.join(dataDir, "schema.sql");
    fs.writeFileSync(schemaPath, schemaSql);
    execFileSync(
      bin("psql"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", "e2e_superuser", "-d", database, "-f", schemaPath],
      { stdio: "pipe" }
    );
  } catch (error) {
    execFileSync(bin("pg_ctl"), ["stop", "-D", dataDir, "-m", "fast"], { stdio: "ignore" });
    throw error;
  }

  const databaseUrl = `postgresql://e2e_superuser@127.0.0.1:${port}/${database}?schema=public`;

  return {
    databaseUrl,
    host: "127.0.0.1",
    port,
    database,
    dataDir,
    stop: () => {
      try {
        execFileSync(bin("pg_ctl"), ["stop", "-D", dataDir, "-m", "fast"], { stdio: "ignore" });
      } catch (error) {
        console.warn("[e2e] arret du cluster Postgres de test echoue (ignore) :", error);
      }
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function buildVectorFreeSchemaSql(): string {
  const raw = fs.readFileSync(path.join(__dirname, "..", "..", "..", "prisma", "portable-init.sql"), "utf8");
  return raw
    .replace('CREATE EXTENSION IF NOT EXISTS "vector";\n\n', "")
    .replace(/\n\s*"embedding" vector,/, "");
}
