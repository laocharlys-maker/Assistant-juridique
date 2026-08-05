#!/usr/bin/env node
// Recupere les binaires PostgreSQL 16 portables (+ compile pgvector) pour
// les embarquer dans l'installeur Tauri. Lance a la CONSTRUCTION de
// l'installeur (npm run build:sea l'inclut), jamais commis dans le repo -
// voir .gitignore (backend/vendor/).
//
// Distribution retenue : le zip "binaries" officiel d'EnterpriseDB
// (get.enterprisedb.com/postgresql/postgresql-<version>-windows-x64-binaries.zip),
// PAS zonkyio/embedded-postgres-binaries. Verifie empiriquement pendant le
// developpement de ce lot : la distribution zonky (pensee pour des tests
// Java embarques) ne contient QUE postgres.exe/initdb.exe/pg_ctl.exe - ni
// pg_dump, ni pg_restore, ni psql, ni pg_isready, qui sont pourtant
// necessaires ici (sauvegardes, provisionnement, health-check). Le zip EDB
// est le meme binaire que celui utilise par l'installeur Windows officiel
// de postgresql.org, juste sans l'installeur ni pgAdmin/StackBuilder (que
// ce script exclut explicitement) - complet (bin/lib/share) pour ~100 Mo.
//
// pgvector n'a AUCUN binaire precompile officiel pour Windows (verifie via
// l'API GitHub : le depot pgvector/pgvector ne publie aucune Release avec
// assets, quelle que soit la plateforme). La seule voie documentee est la
// compilation via `nmake` avec Visual Studio Build Tools, en utilisant les
// en-tetes (include/server) et la lib d'import (lib/postgres.lib) presents
// dans CE MEME zip EDB comme PGROOT. Voir compilePgvector() ci-dessous et
// README-LOT2.md ("Contournement pgvector").
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const https = require("node:https");

const ROOT = path.join(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "postgres");
const CACHE_DIR = path.join(ROOT, "vendor", ".cache");

const PG_VERSION = process.env.AURORE_PG_VERSION || "16.14-1";
const PGVECTOR_TAG = process.env.AURORE_PGVECTOR_TAG || "v0.8.0";

const PLATFORMS = {
  "win-x64": {
    url: `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-windows-x64-binaries.zip`,
    archiveName: `postgresql-${PG_VERSION}-windows-x64-binaries.zip`,
    zipRootDir: "pgsql",
    // Dossiers du zip EDB à ne PAS embarquer : documentation, pgAdmin 4
    // (GUI complète, inutile pour un backend headless), StackBuilder
    // (installeur de modules tiers), et les en-têtes de compilation
    // (nécessaires uniquement pour compiler pgvector au build, pas au
    // runtime - voir compilePgvector, qui les utilise depuis un dossier
    // d'extraction temporaire séparé, jamais copiées dans le résultat final).
    excludeTopLevel: ["doc", "include", "StackBuilder", "pgAdmin 4"],
  },
};

function log(step) {
  console.log(`\n[download-postgres-binaries] ${step}`);
}

function download(url, destFile) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    const file = fs.createWriteStream(destFile);
    const request = (currentUrl, redirectsLeft) => {
      https
        .get(currentUrl, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            if (redirectsLeft <= 0) {
              reject(new Error(`Trop de redirections en telechargeant ${url}`));
              return;
            }
            request(response.headers.location, redirectsLeft - 1);
            return;
          }
          if (response.statusCode !== 200) {
            reject(new Error(`Echec du telechargement de ${currentUrl} : HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on("finish", () => file.close(() => resolve()));
        })
        .on("error", reject);
    };
    request(url, 5);
  });
}

async function fetchArchive(platformKey) {
  const platform = PLATFORMS[platformKey];
  const archivePath = path.join(CACHE_DIR, platform.archiveName);
  if (fs.existsSync(archivePath)) {
    log(`${platform.archiveName} deja en cache (${archivePath}), telechargement ignore.`);
    return archivePath;
  }
  log(`Telechargement de ${platform.url} ...`);
  await download(platform.url, archivePath);
  log(`Telecharge -> ${archivePath}`);
  return archivePath;
}

async function extractArchive(archivePath, destDir) {
  // extract-zip (devDependency) plutot qu'un binaire `unzip`/tar externe :
  // comportement identique sur toutes les plateformes de build, pas de
  // depute a un outil CLI eventuellement absent (Windows n'a pas `unzip`
  // par defaut).
  const extractZip = require("extract-zip");
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  await extractZip(archivePath, { dir: destDir });
}

function removeExcludedTopLevelDirs(extractedRoot, zipRootDir, excludeTopLevel) {
  const base = path.join(extractedRoot, zipRootDir);
  for (const dir of excludeTopLevel) {
    fs.rmSync(path.join(base, dir), { recursive: true, force: true });
  }
}

/**
 * Compile pgvector depuis les sources, en utilisant les en-tetes/la lib
 * d'import du zip EDB comme PGROOT (voir commentaire de tete de fichier).
 * Necessite Visual Studio Build Tools (nmake + cl.exe, "x64 Native Tools").
 * Si absent, echoue avec un message explicite plutot que de degrader
 * silencieusement la fonctionnalite RAG jurisprudence (consigne explicite
 * du lot) - voir README-LOT2.md pour la procedure d'installation du
 * toolchain et le detail de ce contournement.
 */
async function compilePgvector(extractedRoot, zipRootDir, finalVendorDir) {
  const pgroot = path.join(extractedRoot, zipRootDir);
  const hasHeaders = fs.existsSync(path.join(pgroot, "include", "server", "postgres.h"));
  if (!hasHeaders) {
    throw new Error(
      `include/server/postgres.h introuvable sous ${pgroot} - la version telechargee ne semble pas inclure les en-tetes de compilation.`
    );
  }

  let vswhereInstances = "";
  try {
    vswhereInstances = execFileSync(
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe",
      ["-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
      { encoding: "utf8" }
    ).trim();
  } catch {
    // vswhere absent -> pas de Visual Studio du tout.
  }
  if (!vswhereInstances) {
    throw new Error(
      "Visual Studio Build Tools (composant 'Desktop development with C++') introuvable. " +
        "pgvector n'a aucun binaire precompile officiel pour Windows (verifie : aucune Release GitHub avec assets) - " +
        "sa compilation via nmake est la SEULE voie disponible. Installe les Build Tools " +
        "(https://visualstudio.microsoft.com/visual-cpp-build-tools/) puis relance ce script " +
        "depuis un \"x64 Native Tools Command Prompt\". Voir README-LOT2.md (\"Contournement pgvector\")."
    );
  }

  const cacheRepoDir = path.join(CACHE_DIR, `pgvector-${PGVECTOR_TAG}`);
  if (!fs.existsSync(cacheRepoDir)) {
    log(`Clonage de pgvector ${PGVECTOR_TAG}...`);
    execFileSync("git", ["clone", "--branch", PGVECTOR_TAG, "--depth", "1", "https://github.com/pgvector/pgvector.git", cacheRepoDir], {
      stdio: "inherit",
    });
  }

  log("Compilation de pgvector (nmake /F Makefile.win)...");
  const nmakeEnv = { ...process.env, PGROOT: pgroot };
  execFileSync("nmake", ["/F", "Makefile.win", "clean"], { cwd: cacheRepoDir, env: nmakeEnv, stdio: "inherit" });
  execFileSync("nmake", ["/F", "Makefile.win"], { cwd: cacheRepoDir, env: nmakeEnv, stdio: "inherit" });

  const vectorDll = path.join(cacheRepoDir, "vector.dll");
  if (!fs.existsSync(vectorDll)) {
    throw new Error(`Compilation terminee mais ${vectorDll} introuvable - verifie la sortie de nmake ci-dessus.`);
  }

  fs.copyFileSync(vectorDll, path.join(finalVendorDir, "lib", "vector.dll"));

  // vector.control vit a la racine du depot pgvector, mais TOUS les
  // scripts SQL vivent dans le sous-dossier sql/ - jamais a la racine.
  // Verifie directement contre Makefile.win officiel (regle "install:") :
  //   copy vector.control "$(SHAREDIR)\extension"
  //   copy sql\vector--*.sql "$(SHAREDIR)\extension"
  // Ceci inclut sql\vector--0.8.0.sql, qui n'est PAS un fichier statique du
  // depot : il est GENERE par la compilation elle-meme (regle
  // "sql\vector--0.8.0.sql: sql\vector.sql -> copy", declenchee par la
  // dependance "all: $(SHLIB) $(DATA_built)" de Makefile.win) - absent tant
  // que `nmake` n'a pas tourne, ce qui est deja le cas ici (execFileSync
  // ci-dessus). L'ancienne version de cette boucle lisait uniquement
  // fs.readdirSync(cacheRepoDir) (racine du depot) : elle trouvait bien
  // vector.control, mais AUCUN fichier .sql (tous dans sql/, jamais a la
  // racine) - resultat, l'extension s'installait avec un vector.control
  // pointant vers la version 0.8.0 mais sans le script d'installation
  // correspondant, provoquant "extension vector has no installation
  // script nor update path for version 0.8.0" au premier vrai test
  // d'installation. Voir README-LOT2.md.
  fs.copyFileSync(
    path.join(cacheRepoDir, "vector.control"),
    path.join(finalVendorDir, "share", "extension", "vector.control")
  );
  const pgvectorSqlDir = path.join(cacheRepoDir, "sql");
  let sqlFilesCopied = 0;
  for (const file of fs.readdirSync(pgvectorSqlDir)) {
    if (file.startsWith("vector--") && file.endsWith(".sql")) {
      fs.copyFileSync(path.join(pgvectorSqlDir, file), path.join(finalVendorDir, "share", "extension", file));
      sqlFilesCopied += 1;
    }
  }
  const installScript = `vector--${PGVECTOR_TAG.replace(/^v/, "")}.sql`;
  const installScriptPresent = fs.existsSync(path.join(finalVendorDir, "share", "extension", installScript));
  if (!installScriptPresent) {
    throw new Error(
      `${installScript} absent apres compilation (${sqlFilesCopied} script(s) .sql copie(s) au total) - ` +
        `la regle DATA_built de Makefile.win n'a peut-etre pas tourne comme attendu. Verifie la sortie de nmake ci-dessus.`
    );
  }
  log(`pgvector compile et integre a la distribution portable (${sqlFilesCopied} scripts SQL, dont ${installScript}).`);
}

async function buildPlatform(platformKey) {
  const platform = PLATFORMS[platformKey];
  if (!platform) {
    throw new Error(`Plateforme inconnue : ${platformKey}. Disponibles : ${Object.keys(PLATFORMS).join(", ")}`);
  }

  const archivePath = await fetchArchive(platformKey);

  const extractedRoot = path.join(CACHE_DIR, `extracted-${platformKey}`);
  log(`Extraction de l'archive (${platformKey})...`);
  await extractArchive(archivePath, extractedRoot);

  const finalVendorDir = path.join(VENDOR_DIR, platformKey);
  fs.rmSync(finalVendorDir, { recursive: true, force: true });

  // pgvector est compile AVANT de retirer include/ (necessaire a la
  // compilation), qui est nettoye seulement apres, avec les autres dossiers
  // inutiles au runtime.
  await compilePgvector(extractedRoot, platform.zipRootDir, path.join(extractedRoot, platform.zipRootDir));

  removeExcludedTopLevelDirs(extractedRoot, platform.zipRootDir, platform.excludeTopLevel);

  fs.mkdirSync(path.dirname(finalVendorDir), { recursive: true });
  fs.renameSync(path.join(extractedRoot, platform.zipRootDir), finalVendorDir);

  const hasVector = fs.existsSync(path.join(finalVendorDir, "lib", "vector.dll"));
  log(`Distribution portable prete : ${finalVendorDir} (pgvector : ${hasVector ? "OK" : "ABSENT"})`);
}

async function main() {
  const requested = process.argv[2] || (process.platform === "win32" ? "win-x64" : null);
  if (!requested) {
    throw new Error(
      `Plateforme non specifiee et non déductible de process.platform (${process.platform}). ` +
        `Usage : node download-postgres-binaries.js <${Object.keys(PLATFORMS).join("|")}>`
    );
  }
  await buildPlatform(requested);
}

main().catch((error) => {
  console.error(`\n[download-postgres-binaries] ECHEC : ${error.message}`);
  process.exit(1);
});
