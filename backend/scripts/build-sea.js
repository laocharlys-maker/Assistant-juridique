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

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const OUT = path.join(ROOT, "dist-sea");
const SEA_CONFIG = path.join(ROOT, "sea-config.json");
const SEA_PATHS_FILE = path.join(DIST, "lib", "seaPaths.js");

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
 * Applique via un plugin esbuild (onLoad) plutot qu'en pre-passe sur
 * disque : le fichier source compile (dist/) reste intact, seule la copie
 * chargee par esbuild pour le bundling est transformee.
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
  const relDir = path.relative(DIST, fileDir).split(path.sep).join("/");
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
    shimDecls +=
      `const __aurore_dirname = ${appRootExpr}` + (relDir ? ` + ${JSON.stringify(path.sep + relDir)};\n` : ";\n");
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

/**
 * Plugin esbuild : applique shimFileSource() a chaque fichier de dist/ au
 * moment ou esbuild le charge pour le bundling - dist/ lui-meme n'est
 * jamais modifie sur disque (reste le code source clair utilise tel quel
 * par `npm start` en mode VPS/externe).
 */
function nativeDepsShimPlugin() {
  return {
    name: "aurore-sea-native-deps-shim",
    setup(build) {
      build.onLoad({ filter: /\.js$/ }, (args) => {
        if (!args.path.startsWith(DIST)) return null;
        const source = fs.readFileSync(args.path, "utf8");
        const transformed = shimFileSource(args.path, source);
        if (transformed === null) return null;
        return { contents: transformed, loader: "js" };
      });
    },
  };
}

async function bundle() {
  log("Bundle esbuild (dist/index.js -> dist-sea/bundle.cjs)");
  const result = await esbuild.build({
    entryPoints: [path.join(DIST, "index.js")],
    outfile: path.join(OUT, "bundle.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: [...EXTERNAL_PACKAGES_WITH_ASSETS],
    plugins: [nativeDepsShimPlugin()],
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
  log("Copie des fichiers compagnons (public/, .env, node_modules partiel)");

  copyDir(path.join(ROOT, "public"), path.join(OUT, "public"));

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
