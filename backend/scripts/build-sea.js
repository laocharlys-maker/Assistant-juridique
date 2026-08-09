#!/usr/bin/env node
// Empaquette le backend Express/TS compile (dist/) en un executable Node
// unique (Node SEA - Single Executable Application), pour etre lance comme
// sidecar par la coquille desktop Tauri (voir ../../src-tauri).
//
// Prerequis : `npm run build` (tsc) et `npm run prisma:generate` deja
// executes - orchestre automatiquement par le script "build:sea" de
// package.json.
//
// Etapes :
//   1. Bundle dist/index.js (+ dependances JS pures) en un seul fichier CJS
//      via esbuild. @prisma/client et pdfkit sont exclus du bundle (voir
//      "Blocages rencontres" dans README-LOT1.md) et copies tels quels a
//      cote de l'executable.
//   2. Genere le blob SEA (node --experimental-sea-config) et l'injecte
//      dans une copie du binaire node courant via postject.
//   3. Copie les fichiers compagnons (public/, node_modules partiel, .env)
//      a cote de l'executable produit, dans dist-sea/.
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");
const JavaScriptObfuscator = require("javascript-obfuscator");
const obfuscatorConfig = require("../obfuscator.config.js");

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "dist-sea");
// Copie de travail de dist/ (code Aurore uniquement, ~0.6 Mo) sur laquelle
// le shim SEA (__dirname/require des paquets externes, voir plus bas) puis
// l'obfuscation (Lot 7) sont appliques AVANT le bundling esbuild - jamais
// dist/ directement, qui doit rester le code source pur (utilise tel quel
// par `npm start` en mode VPS/externe, sans obfuscation). Recreee a chaque
// build.
const WORK_DIR = path.join(ROOT, "dist-sea-obf-src");
// Jamais livre avec le binaire client (voir tauri.conf.json bundle.resources,
// qui ne reference que dist-sea/) - copie lisible (shimmee mais NON
// obfusquee) du code Aurore, conservee uniquement en local pour deboguer un
// crash de production a partir d'un rapport d'erreur (Lot 7, voir
// README-LOT7.md "Deboguer un crash en production").
const DEBUG_OUT = path.join(ROOT, "dist-sea-debug");
const SEA_CONFIG = path.join(ROOT, "sea-config.json");
const SEA_PATHS_FILE = path.join(WORK_DIR, "lib", "seaPaths.js");

// Dependances qui font des lectures disque relatives a leur propre
// __dirname au runtime (fonts, moteur natif...) : on ne peut pas les
// inliner dans le bundle, on les garde donc "externes" pour esbuild et on
// les copie telles quelles a cote de l'executable (voir copyCompanionFiles).
const EXTERNAL_PACKAGES_WITH_ASSETS = ["@prisma/client", "pdfkit"];

function log(step) {
  console.log(`\n[build-sea] ${step}`);
}

function assertDistBuilt() {
  if (!fs.existsSync(path.join(DIST, "index.js"))) {
    console.error(
      "[build-sea] dist/index.js introuvable. Lance d'abord `npm run build` (ou utilise `npm run build:sea`, qui l'inclut deja)."
    );
    process.exit(1);
  }
}

function assertPrismaClientGenerated() {
  const generated = path.join(ROOT, "node_modules", ".prisma", "client");
  if (!fs.existsSync(generated)) {
    console.error(
      "[build-sea] Client Prisma non genere (node_modules/.prisma/client absent). Lance d'abord `npm run prisma:generate`."
    );
    process.exit(1);
  }
}

/**
 * esbuild "bake" __dirname/__filename de chaque fichier source en une
 * constante litterale correspondant a SON chemin d'ORIGINE sur la machine
 * de build (verifie empiriquement : esbuild ne les fait pas pointer vers le
 * fichier bundle final, ni vers une valeur runtime). Une fois empaquete
 * dans l'executable SEA, ce chemin absolu de build n'existe evidemment plus
 * chez l'utilisateur final, ce qui casse express.static(...) et les
 * dossiers d'upload.
 *
 * On neutralise donc __dirname, uniquement pour NOTRE code compile (jamais
 * pour les node_modules : pdfkit par ex. l'utilise legitimement pour ses
 * fonts et est de toute facon exclu du bundle, voir EXTERNAL_PACKAGES_WITH_ASSETS),
 * en le renommant en __aurore_dirname et en le redefinissant a partir de
 * appRoot() (src/lib/seaPaths.ts), qui sait distinguer le mode SEA du mode
 * normal. On evite d'utiliser le nom "__dirname" pour la variable injectee
 * car esbuild continuerait sinon a le substituer par sa valeur figee.
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Deuxieme probleme decouvert (le premier etant __dirname, voir plus haut) :
 * a l'interieur du blob SEA, require() d'un specifier "nu" comme
 * "@prisma/client" ne passe PAS par la resolution node_modules habituelle -
 * Node le traite comme s'il devait forcement s'agir d'un module natif
 * embarque et echoue avec ERR_UNKNOWN_BUILTIN_MODULE, meme si le dossier
 * node_modules existe bien a cote de l'executable. Verifie empiriquement en
 * lancant le binaire produit.
 *
 * Le contournement : Node sait en revanche charger un fichier reel sur
 * disque quand require() recoit un CHEMIN (absolu ou commencant par "./"),
 * ce qui n'emprunte plus le chemin "builtin-only". On reecrit donc, pour
 * chaque paquet de EXTERNAL_PACKAGES_WITH_ASSETS, le require("pkg") d'origine
 * en require(appRoot() + "/node_modules/pkg"), calcule au runtime.
 *
 * Applique en PRE-PASSE directement sur les fichiers de WORK_DIR (Lot 7),
 * plutot qu'a l'interieur du plugin esbuild comme avant ce lot : ce
 * remplacement de texte doit imperativement s'executer AVANT l'obfuscation
 * (voir obfuscateWorkDir) - une fois les chaines litterales "@prisma/client"
 * eventuellement deplacees dans le tableau de chaines de l'obfuscateur, ce
 * regex ne les retrouverait plus. Le require(...) genere par ce shim
 * lui-meme (__aurore_require(...)) reste lui parfaitement obfuscable sans
 * probleme ensuite : sa valeur est resolue a l'execution, pas par un regex
 * de build.
 */
function shimFileSource(filePath, source) {
  if (filePath === SEA_PATHS_FILE) {
    return null; // implementation de appRoot() elle-meme : laisser tel quel
  }

  const needsDirnameShim = /\b__dirname\b/.test(source);
  const externalRequireRegexes = EXTERNAL_PACKAGES_WITH_ASSETS.map(
    (pkg) => new RegExp(`require\\((["'])${escapeRegExp(pkg)}\\1\\)`, "g")
  );
  const needsExternalRequireShim = externalRequireRegexes.some((re) => re.test(source));
  if (!needsDirnameShim && !needsExternalRequireShim) {
    return null;
  }

  let transformed = source;
  const fileDir = path.dirname(filePath);
  const relDir = path.relative(WORK_DIR, fileDir).split(path.sep).join("/");
  let seaPathsSpecifier = path
    .relative(fileDir, SEA_PATHS_FILE)
    .split(path.sep)
    .join("/")
    .replace(/\.js$/, "");
  if (!seaPathsSpecifier.startsWith(".")) {
    seaPathsSpecifier = "./" + seaPathsSpecifier;
  }
  const appRootExpr = `require(${JSON.stringify(seaPathsSpecifier)}).appRoot()`;

  let shimDecls = "";

  if (needsDirnameShim) {
    transformed = transformed.replace(/\b__dirname\b/g, "__aurore_dirname");
    // BUG REEL CORRIGE ICI (constate : express.static() pointait vers un
    // dossier public/ inexistant une fois empaquete -> "Cannot GET /" alors
    // que le serveur demarrait normalement) : __dirname pointait a l'origine
    // vers dist/<relDir> (WORK_DIR est une copie de dist/, un niveau
    // intermediaire entre la racine du backend et le fichier). Ce niveau
    // "dist" disparait entierement une fois empaquete - appRoot() designe
    // directement la racine deployee, qui contient public/, node_modules/...
    // comme enfants IMMEDIATS (voir seaPaths.ts), pas un equivalent de
    // dist/. Sans le segment de compensation "__aurore_dist" ci-dessous
    // (qui n'a besoin d'exister nulle part sur le disque - path.join()/".."
    // est de la pure manipulation de chaine), chaque `path.join(__dirname,
    // "..", ...)` du code d'origine remontait d'un niveau de trop une fois
    // dans le binaire SEA.
    const aurorDirnameSuffix = path.sep + "__aurore_dist" + (relDir ? path.sep + relDir : "");
    shimDecls += `const __aurore_dirname = ${appRootExpr} + ${JSON.stringify(aurorDirnameSuffix)};\n`;
  }

  if (needsExternalRequireShim) {
    // require() ordinaire, meme avec un chemin absolu calcule au runtime,
    // ne fonctionne PAS depuis le code embarque dans le blob SEA : Node le
    // route vers "embedderRequire", qui ne resout que les modules natifs
    // (ERR_UNKNOWN_BUILTIN_MODULE sinon) - verifie empiriquement. Seul
    // module.createRequire(fichier-reel) echappe a cette restriction et
    // retrouve la resolution node_modules normale.
    shimDecls +=
      `const __aurore_require = require("node:module").createRequire(${appRootExpr} + "/node_modules/aurore-sea-shim.js");\n`;
    for (const [index, pkg] of EXTERNAL_PACKAGES_WITH_ASSETS.entries()) {
      transformed = transformed.replace(externalRequireRegexes[index], `__aurore_require(${JSON.stringify(pkg)})`);
    }
  }

  return shimDecls + transformed;
}

function listJsFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

/**
 * Prepare WORK_DIR (Lot 7) : copie de dist/ (code Aurore uniquement, jamais
 * les node_modules vendus - voir README-LOT7.md "Pourquoi ne pas obfusquer
 * le bundle complet") sur laquelle sont appliques, dans l'ordre, le shim SEA
 * (__dirname/require des paquets externes - voir shimFileSource) PUIS
 * l'obfuscation. dist/ lui-meme n'est jamais modifie (reste le code source
 * clair utilise tel quel par `npm start` en mode VPS/externe).
 */
function prepareWorkDir() {
  log("Preparation de la copie de travail (dist/ -> dist-sea-obf-src/)");
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.cpSync(DIST, WORK_DIR, { recursive: true });

  fs.mkdirSync(DEBUG_OUT, { recursive: true });

  for (const filePath of listJsFiles(WORK_DIR)) {
    const source = fs.readFileSync(filePath, "utf8");
    const shimmed = shimFileSource(filePath, source);
    if (shimmed !== null) {
      fs.writeFileSync(filePath, shimmed);
    }
  }

  // Copie de reference, lisible (shimmee mais pas encore obfusquee) -
  // conservee pour deboguer un crash de production (voir plus bas et
  // README-LOT7.md), avant que l'etape suivante ne renomme les
  // identifiants/deplace les chaines litterales.
  fs.rmSync(path.join(DEBUG_OUT, "dist-shimmed"), { recursive: true, force: true });
  fs.cpSync(WORK_DIR, path.join(DEBUG_OUT, "dist-shimmed"), { recursive: true });
}

/**
 * Decouvre, dans TOUT le code de WORK_DIR (deja shimme, avant obfuscation),
 * l'ensemble exact des chaines litterales utilisees comme specificateur
 * direct d'un import()/require() - ex: "./config/env", "dotenv/config",
 * "node:crypto". Ces chaines doivent survivre l'obfuscation SANS etre
 * deplacees dans le tableau de chaines (stringArray) : esbuild a besoin de
 * les voir telles quelles, en clair, au moment du bundling pour resoudre et
 * inliner correctement chaque module - voir obfuscateWorkDir et
 * README-LOT7.md pour le bug concret que ceci corrige (ERR_UNKNOWN_BUILTIN_MODULE
 * a l'execution du binaire final).
 *
 * Extraction directe du code reellement present (regex sur require()/import())
 * plutot qu'une regle devinee (ex: "commence par ./") : garantit une
 * couverture complete et exacte, y compris pour les specificateurs de
 * paquets tiers non relatifs (comme "dotenv/config"), sans dependre d'un
 * motif suppose.
 */
function discoverModuleSpecifiers(workDir) {
  const specifiers = new Set();
  const pattern = /\b(?:require|import)\(\s*(["'])((?:(?!\1).)+)\1\s*\)/g;
  for (const filePath of listJsFiles(workDir)) {
    const source = fs.readFileSync(filePath, "utf8");
    let match;
    while ((match = pattern.exec(source))) {
      specifiers.add(match[2]);
    }
  }
  return [...specifiers];
}

/**
 * Obfusque chaque fichier de WORK_DIR INDIVIDUELLEMENT (Lot 7) - jamais le
 * bundle complet apres coup (voir README-LOT7.md "Obfuscation - ajustements
 * empiriques") : le code Aurore lui-meme ne pese qu'environ 0.6 Mo une fois
 * compile, contre pres de 17 Mo pour le bundle final une fois toutes les
 * dependances (SDK Anthropic/Gemini, docx, mammoth...) incluses - obfusquer
 * ce bundle complet fait sortir javascript-obfuscator en "heap out of
 * memory" meme avec des reglages moderes. Obfusquer fichier par fichier
 * AVANT le bundling esbuild reste parfaitement valide (chaque module
 * CommonJS est deja isole - les references inter-fichiers passent par
 * require()/module.exports, jamais par un identifiant renomme) et evite le
 * probleme entierement, en plus d'etre nettement plus rapide.
 *
 * Desactivable pour un cycle de developpement rapide via
 * AURORE_SKIP_OBFUSCATION=1 (jamais en production - le script
 * d'installation/CI ne doit jamais definir cette variable).
 */
function obfuscateWorkDir() {
  if (process.env.AURORE_SKIP_OBFUSCATION === "1") {
    log(
      "Obfuscation SAUTEE (AURORE_SKIP_OBFUSCATION=1) - code laisse lisible, a ne JAMAIS utiliser pour une version livree a un cabinet."
    );
    return;
  }

  log("Obfuscation du code Aurore (javascript-obfuscator, fichier par fichier)");
  const t0 = Date.now();
  const files = listJsFiles(WORK_DIR);
  let totalOriginalBytes = 0;
  let totalObfuscatedBytes = 0;

  const moduleSpecifiers = discoverModuleSpecifiers(WORK_DIR);
  const configWithReservedSpecifiers = {
    ...obfuscatorConfig,
    reservedStrings: [
      ...(obfuscatorConfig.reservedStrings || []),
      ...moduleSpecifiers.map((specifier) => `^${escapeRegExp(specifier)}$`),
    ],
  };
  console.log(`[build-sea] ${moduleSpecifiers.length} specificateur(s) d'import/require proteges de l'obfuscation (voir README-LOT7.md).`);

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    totalOriginalBytes += Buffer.byteLength(source);
    const result = JavaScriptObfuscator.obfuscate(source, configWithReservedSpecifiers);
    const obfuscated = result.getObfuscatedCode();
    fs.writeFileSync(filePath, obfuscated);
    totalObfuscatedBytes += Buffer.byteLength(obfuscated);

    const sourceMap = result.getSourceMap();
    if (sourceMap) {
      const relPath = path.relative(WORK_DIR, filePath);
      const mapPath = path.join(DEBUG_OUT, "obfuscated-maps", `${relPath}.map`);
      fs.mkdirSync(path.dirname(mapPath), { recursive: true });
      fs.writeFileSync(mapPath, sourceMap);
    }
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[build-sea] ${files.length} fichier(s) obfusque(s) en ${(durationMs / 1000).toFixed(1)}s ` +
      `(${(totalOriginalBytes / 1024).toFixed(0)} Ko -> ${(totalObfuscatedBytes / 1024).toFixed(0)} Ko).`
  );
  console.log(
    `[build-sea] Copie lisible (shimmee, non obfusquee) + source maps par fichier conservees dans ${DEBUG_OUT} (jamais livrees au client).`
  );
}

async function bundle() {
  log("Bundle esbuild (dist-sea-obf-src/index.js -> dist-sea/bundle.cjs)");
  const result = await esbuild.build({
    entryPoints: [path.join(WORK_DIR, "index.js")],
    outfile: path.join(OUT, "bundle.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: [...EXTERNAL_PACKAGES_WITH_ASSETS],
    logLevel: "warning",
    metafile: false,
  });
  if (result.errors.length > 0) {
    console.error(result.errors);
    process.exit(1);
  }
}

function generateSeaBlob() {
  log("Generation du blob SEA (node --experimental-sea-config)");
  execFileSync(
    process.execPath,
    ["--experimental-sea-config", path.relative(ROOT, SEA_CONFIG)],
    { cwd: ROOT, stdio: "inherit" }
  );
}

function exeName() {
  return process.platform === "win32" ? "aurore-backend.exe" : "aurore-backend";
}

/**
 * Retire la signature Authenticode d'un executable PE Windows en patchant
 * directement l'en-tete, sans dependre de signtool.exe (Windows SDK, pas
 * installe par defaut - absent de cette machine de dev, et rien ne garantit
 * qu'il le soit ailleurs). Necessaire car le node.exe officiel distribue
 * par nodejs.org est signe, et postject refuse d'injecter le blob SEA dans
 * un binaire signe (la signature ne correspondrait plus au contenu modifie).
 *
 * Implementation : la signature Authenticode d'un PE est un bloc de donnees
 * (WIN_CERTIFICATE) appende a la fin du fichier, reference par l'entree
 * "Certificate Table" (index 4) du tableau Data Directories de l'Optional
 * Header. La retirer revient a mettre cette entree a zero puis a tronquer
 * le fichier pour supprimer le bloc appende. Voir la specification
 * Microsoft PE/COFF ("Optional Header Data Directories (Image Only)").
 */
function stripWindowsSignature(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error(`${filePath} ne semble pas etre un PE valide (signature MZ absente).`);
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOffset) !== 0x00004550 /* 'PE\0\0' */) {
    throw new Error(`${filePath} : en-tete PE introuvable a l'offset ${peOffset}.`);
  }
  const optionalHeaderOffset = peOffset + 4 + 20;
  const magic = buf.readUInt16LE(optionalHeaderOffset);
  if (magic !== 0x20b) {
    // 0x20b = PE32+ (x64), seul format produit par les binaires node.exe officiels.
    throw new Error(`Format PE non supporte (magic=0x${magic.toString(16)}), attendu PE32+ (0x20b).`);
  }
  const dataDirectoryOffset = optionalHeaderOffset + 112;
  const certEntryOffset = dataDirectoryOffset + 4 * 8; // index 4 = IMAGE_DIRECTORY_ENTRY_SECURITY
  const certTableFileOffset = buf.readUInt32LE(certEntryOffset);
  const certTableSize = buf.readUInt32LE(certEntryOffset + 4);

  if (certTableSize === 0) {
    return false; // deja non signe
  }

  buf.writeUInt32LE(0, certEntryOffset);
  buf.writeUInt32LE(0, certEntryOffset + 4);

  const truncateAt = certTableFileOffset > 0 ? certTableFileOffset : buf.length;
  fs.writeFileSync(filePath, buf.subarray(0, truncateAt));
  return true;
}

function copyNodeBinary() {
  log("Copie du binaire node courant");
  const target = path.join(OUT, exeName());
  fs.copyFileSync(process.execPath, target);
  if (process.platform === "win32") {
    const stripped = stripWindowsSignature(target);
    console.log(
      stripped
        ? "[build-sea] Signature Authenticode retiree du binaire copie."
        : "[build-sea] Binaire node non signe, rien a retirer."
    );
  } else {
    fs.chmodSync(target, 0o755);
  }
  return target;
}

/**
 * Le "sentinel fuse" (chaine placeholder embarquee dans le binaire node.exe
 * officiel, que postject recherche puis marque comme "actif" une fois le
 * blob injecte) n'est pas une constante stable inter-versions : la valeur
 * documentee historiquement (fce680ab-2cc467b5-b6e075f4-31af79b2) ne
 * correspond pas a celle presente dans le node.exe installe ici (v24) -
 * on l'extrait donc directement du binaire plutot que de la coder en dur.
 */
function findSentinelFuse(exePath) {
  const text = fs.readFileSync(exePath).toString("latin1");
  const match = text.match(/NODE_SEA_FUSE_[0-9a-f]{32}/);
  if (!match) {
    throw new Error(
      `Sentinel NODE_SEA_FUSE introuvable dans ${exePath} - le binaire node utilise ne supporte peut-etre pas Node SEA (Node >= 20.12 / 21.7 requis).`
    );
  }
  return match[0];
}

function injectBlob(exePath) {
  log("Injection du blob dans l'executable (postject)");
  const blobPath = path.join(OUT, "sea-prep.blob");
  const postjectCli = require.resolve("postject/dist/cli.js");
  const sentinelFuse = findSentinelFuse(exePath);
  execFileSync(
    process.execPath,
    [postjectCli, exePath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", sentinelFuse],
    { stdio: "inherit" }
  );
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

function copyCompanionFiles() {
  log("Copie des fichiers compagnons (public/, .env, node_modules partiel, postgres portable)");

  copyDir(path.join(ROOT, "public"), path.join(OUT, "public"));

  // package.json (Lot 8) : uniquement pour son champ "version", lu par
  // security/licenceManager.ts (phone-home) et routes/appInfo.ts (ecran
  // "A propos") via appRoot() - jamais copie jusqu'ici, ces deux lectures
  // echouaient donc silencieusement dans le binaire empaquete (repli sur
  // "0.0.0-inconnue"). Jamais les scripts/dependances (sans interet et
  // potentiellement verbeux une fois empaquete).
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(OUT, "package.json"));

  // Lot 2 (Postgres portable) : binaires prepares par
  // `npm run postgres:download-binaries` (voir scripts/download-postgres-binaries.js,
  // non commis - backend/vendor/ est gitignore) et script de schema genere
  // par `npm run prisma:portable-sql`. Absents en mode DATABASE_MODE=externe
  // (VPS, comportement du Lot 1 inchange) : on les copie s'ils existent,
  // sans faire echouer le build sinon (l'app peut toujours tourner en mode
  // externe sans ces fichiers).
  const vendorPostgresDir = path.join(ROOT, "vendor", "postgres");
  if (fs.existsSync(vendorPostgresDir)) {
    copyDir(vendorPostgresDir, path.join(OUT, "postgres"));
  } else {
    console.warn(
      "[build-sea] backend/vendor/postgres absent (lance `npm run postgres:download-binaries` au prealable) - " +
        "DATABASE_MODE=portable ne fonctionnera pas dans ce binaire, DATABASE_MODE=externe/reseau restent inchanges."
    );
  }

  const portableSchemaSql = path.join(ROOT, "prisma", "portable-init.sql");
  if (fs.existsSync(portableSchemaSql)) {
    fs.mkdirSync(path.join(OUT, "prisma"), { recursive: true });
    fs.copyFileSync(portableSchemaSql, path.join(OUT, "prisma", "portable-init.sql"));
  }

  // Migrations incrementales (voir src/database/applyPendingMigrations.ts) -
  // portable-init.sql ci-dessus ne sert qu'a la toute premiere
  // initialisation d'un cluster neuf ; ce dossier permet a une installation
  // EXISTANTE (mise a jour depuis une version anterieure) de recevoir les
  // tables/colonnes ajoutees depuis, sans quoi le backend plante au
  // demarrage suivant sur la premiere requete touchant le nouvel objet.
  const migrationsDir = path.join(ROOT, "prisma", "migrations");
  if (fs.existsSync(migrationsDir)) {
    copyDir(migrationsDir, path.join(OUT, "prisma", "migrations"));
  }

  const envFile = path.join(ROOT, ".env");
  if (fs.existsSync(envFile)) {
    fs.copyFileSync(envFile, path.join(OUT, ".env"));
  } else {
    console.warn(
      "[build-sea] Pas de .env trouve a la racine du backend - le binaire ne demarrera pas sans DATABASE_URL/SESSION_SECRET. Copie backend/.env.example vers backend/.env et complete-le avant de tester."
    );
  }

  const outNodeModules = path.join(OUT, "node_modules");
  fs.mkdirSync(outNodeModules, { recursive: true });

  // Le client Prisma genere (.prisma/client) contient le moteur natif
  // (query_engine-*.node) charge en interne par @prisma/client - les deux
  // doivent etre copies, meme si seul @prisma/client est require()
  // directement par notre code.
  copyDir(path.join(ROOT, "node_modules", ".prisma", "client"), path.join(outNodeModules, ".prisma", "client"));

  for (const relPackageDir of resolveRequireClosure(EXTERNAL_PACKAGES_WITH_ASSETS)) {
    copyDir(path.join(ROOT, "node_modules", relPackageDir), path.join(outNodeModules, relPackageDir));
  }
}

/**
 * Copier uniquement le dossier node_modules/<pkg> d'un paquet externe (voir
 * EXTERNAL_PACKAGES_WITH_ASSETS) ne suffit pas : ses propres dependances
 * (ex: pdfkit -> @noble/hashes, @noble/ciphers, fontkit, js-md5, linebreak,
 * png-js) vivent normalement a cote dans node_modules/, pas a l'interieur -
 * les ignorer casse le require() de ces paquets une fois isoles dans
 * dist-sea/ (constate empiriquement : `Cannot find module '@noble/hashes/utils'`
 * a l'execution). On calcule donc la fermeture reelle des dependances en
 * les REQUERANT pour de vrai (dans un process separe, jetable) et en
 * inspectant require.cache, plutot que de deviner via les package.json
 * (evite de reimplementer l'algorithme de resolution de Node, y compris les
 * cas de nesting comme node_modules/linebreak/node_modules/base64-js,
 * present ici).
 */
function resolveRequireClosure(packageNames) {
  const probeScript = `
    const path = require("node:path");
    for (const name of ${JSON.stringify(packageNames)}) require(name);
    const nodeModulesMarker = path.sep + "node_modules" + path.sep;
    const packageDirs = new Set();
    for (const filename of Object.keys(require.cache)) {
      let dir = path.dirname(filename);
      while (dir.includes("node_modules") && !fsExists(path.join(dir, "package.json"))) {
        dir = path.dirname(dir);
      }
      if (!dir.includes(nodeModulesMarker) && !dir.endsWith(path.sep + "node_modules")) continue;
      if (!fsExists(path.join(dir, "package.json"))) continue;
      const idx = dir.indexOf(nodeModulesMarker);
      if (idx === -1) continue;
      packageDirs.add(dir.slice(idx + nodeModulesMarker.length).split(path.sep).join("/"));
    }
    function fsExists(p) { try { require("node:fs").accessSync(p); return true; } catch { return false; } }
    process.stdout.write(JSON.stringify([...packageDirs]));
  `;
  const output = execFileSync(process.execPath, ["-e", probeScript], { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(output);
}

/**
 * Sur Windows, un antivirus (Defender ou autre) qui scanne le .exe fraichement
 * ecrit lors du run precedent peut retenir un verrou bref sur dist-sea/,
 * faisant echouer rmSync avec EPERM juste apres la fin du build precedent.
 * Observe a plusieurs reprises pendant le developpement de ce script - on
 * retente donc quelques fois avant d'abandonner.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rmOutDirWithRetry(retries = 5, delayMs = 500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      fs.rmSync(OUT, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === retries) throw error;
      sleepSync(delayMs);
    }
  }
}

async function main() {
  assertDistBuilt();
  assertPrismaClientGenerated();

  rmOutDirWithRetry();
  fs.mkdirSync(OUT, { recursive: true });

  prepareWorkDir();
  obfuscateWorkDir();
  await bundle();
  generateSeaBlob();
  const exePath = copyNodeBinary();
  injectBlob(exePath);
  copyCompanionFiles();

  log("Termine.");
  console.log(`  Executable : ${exePath}`);
  console.log("  Test manuel :");
  console.log(`    cd "${OUT}"`);
  console.log(`    ./${exeName()}`);
  console.log(`    curl http://127.0.0.1:3000/health`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
