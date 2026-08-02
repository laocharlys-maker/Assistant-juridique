#!/usr/bin/env node
// Lot 7 : revue de securite basique, a relancer avant chaque nouvelle
// version livree a un cabinet (voir README-LOT7.md "Procedure de
// verification avant chaque version").
//
// Deux verifications :
//   1. `npm audit` - vulnerabilites connues dans les dependances.
//   2. Recherche de console.log/error/warn/info qui loguerait la VALEUR
//      d'une donnee sensible (mot de passe, token, cle, licence,
//      empreinte machine) dans src/ - jamais les valeurs elles-memes,
//      seulement des booleens/compteurs de statut (convention deja
//      etablie dans tout le projet depuis le Lot 2bis).
//
// Usage : npm run security-audit
// Sortie non-nulle si des vulnerabilites HIGH/CRITICAL sont trouvees, ou si
// un console.* suspect est detecte - concu pour bloquer un pipeline de
// publication, pas juste informer.

const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");

// Mots-cles exacts demandes par le prompt Lot 7, plus les variantes sans
// accent deja utilisees dans les conventions du projet (voir Lots 2bis/3 -
// le code source de ce projet evite systematiquement les accents dans les
// identifiants).
const SENSITIVE_KEYWORDS = ["password", "motdepasse", "token", "cle", "licence", "empreinte", "secret"];

function log(line) {
  console.log(line);
}

// ============================================================================
// 1) npm audit
// ============================================================================

function runNpmAudit() {
  log("\n=== 1) npm audit (dependances) ===");
  let report;
  try {
    // Sur Windows, "npm" est un script .cmd (pas un .exe) : execFileSync ne
    // le retrouve pas sans shell:true (meme contrainte que d'autres CLI
    // Node.js sur Windows, deja rencontree pour wrangler/nssm).
    const raw = execFileSync("npm", ["audit", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    report = JSON.parse(raw);
  } catch (error) {
    // npm audit termine avec un code de sortie non nul des qu'il trouve AU
    // MOINS une vulnerabilite - execFileSync leve alors une erreur, mais
    // stdout contient quand meme le JSON complet (voir error.stdout).
    if (error.stdout) {
      try {
        report = JSON.parse(error.stdout);
      } catch {
        log("npm audit : sortie illisible - executer `npm audit` manuellement pour le detail.");
        return { ok: false, counts: null };
      }
    } else {
      log(`npm audit n'a pas pu s'executer (${error.message}).`);
      return { ok: false, counts: null };
    }
  }

  const counts = (report.metadata && report.metadata.vulnerabilities) || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (total === 0) {
    log("Aucune vulnerabilite connue detectee.");
    return { ok: true, counts };
  }

  log(`${total} vulnerabilite(s) detectee(s) :`);
  for (const [severity, count] of Object.entries(counts)) {
    if (count > 0) log(`  - ${severity} : ${count}`);
  }

  // Liste les paquets concernes pour un diagnostic rapide sans re-taper
  // `npm audit` a la main.
  const vulnerablePackages = Object.keys(report.vulnerabilities || {});
  if (vulnerablePackages.length > 0) {
    log(`Paquets concernes : ${vulnerablePackages.join(", ")}`);
  }

  const blocking = (counts.high || 0) + (counts.critical || 0);
  return { ok: blocking === 0, counts };
}

// ============================================================================
// 2) Recherche de console.* logant potentiellement une donnee sensible
// ============================================================================

/**
 * Retire le contenu des chaines litterales simples/doubles ('...'/"...")
 * d'un extrait de code (remplace par des espaces, pour preserver les
 * numeros de colonne) et, pour les template literals (`...`), ne garde que
 * le contenu des interpolations ${...} (le texte statique autour est aussi
 * une chaine litterale). Objectif : ne detecter un mot-cle sensible QUE
 * quand il apparait comme identifiant de code (une variable/propriete
 * loguee), jamais comme simple mention dans un message ("[licence] statut
 * evalue..." reste silencieux, `password: ${password}` est detecte).
 *
 * Implementation deliberement simple (parcours caractere par caractere,
 * pas un vrai parseur JS) - voir README-LOT7.md "Limites" : peut manquer
 * des cas construits de facon inhabituelle, c'est une detection "basique"
 * comme demande, pas un remplacement d'une revue de code humaine.
 */
function stripStringLiterals(code) {
  let result = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < code.length && code[j] !== quote) {
        if (code[j] === "\\") j++;
        j++;
      }
      result += " ".repeat(j - i + 1);
      i = j + 1;
    } else if (ch === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === "$" && code[j + 1] === "{") {
          depth++;
          result += "  ";
          j += 2;
          continue;
        }
        if (depth > 0 && code[j] === "}") {
          depth--;
          result += "}";
          j++;
          continue;
        }
        if (depth > 0) {
          result += code[j]; // a l'interieur d'une interpolation : du code, on garde
        } else if (code[j] === "`") {
          break;
        } else {
          result += " ";
        }
        j++;
      }
      i = j + 1;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

function containsSensitiveIdentifier(strippedCode) {
  const identifiers = strippedCode.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
  for (const identifier of identifiers) {
    const lower = identifier.toLowerCase();
    // "console"/"log"/"error"/"warn"/"info" font partie de l'appel lui-meme,
    // jamais une donnee sensible - evite un faux positif garanti sur
    // chaque occurrence de "console.error(...)".
    if (["console", "log", "error", "warn", "info"].includes(lower)) continue;
    for (const keyword of SENSITIVE_KEYWORDS) {
      if (lower.includes(keyword)) return { identifier, keyword };
    }
  }
  return null;
}

function findConsoleCalls(source) {
  const calls = [];
  const callStartRegex = /console\.(log|error|warn|info)\s*\(/g;
  let match;
  while ((match = callStartRegex.exec(source))) {
    const start = match.index;
    let depth = 0;
    let i = match.index + match[0].length - 1; // position du "(" d'ouverture
    let end = source.length;
    for (; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    calls.push({ start, end, text: source.slice(start, end) });
  }
  return calls;
}

function listSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.js")) continue;
      files.push(full);
    }
  }
  return files;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split("\n").length;
}

function scanConsoleCalls() {
  log("\n=== 2) Recherche de console.* logant potentiellement une donnee sensible ===");
  const files = listSourceFiles(SRC_DIR);
  const findings = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const call of findConsoleCalls(source)) {
      const stripped = stripStringLiterals(call.text);
      const hit = containsSensitiveIdentifier(stripped);
      if (hit) {
        findings.push({
          file: path.relative(ROOT, file),
          line: lineNumberAt(source, call.start),
          identifier: hit.identifier,
          keyword: hit.keyword,
          excerpt: call.text.replace(/\s+/g, " ").slice(0, 140),
        });
      }
    }
  }

  if (findings.length === 0) {
    log(`Aucun console.* suspect detecte (${files.length} fichiers analyses dans src/).`);
    return { ok: true, findings };
  }

  log(`${findings.length} console.* suspect(s) detecte(s) :`);
  for (const f of findings) {
    log(`  - ${f.file}:${f.line} - identifiant "${f.identifier}" (mot-cle "${f.keyword}")`);
    log(`      ${f.excerpt}`);
  }
  return { ok: false, findings };
}

// ============================================================================

function main() {
  log(`Audit de securite Aurore - ${new Date().toISOString()}`);

  const auditResult = runNpmAudit();
  const consoleResult = scanConsoleCalls();

  log("\n=== Resume ===");
  log(`npm audit (HIGH/CRITICAL) : ${auditResult.ok ? "OK" : "ECHEC"}`);
  log(`console.* sensibles : ${consoleResult.ok ? "OK" : "ECHEC"}`);

  if (!auditResult.ok || !consoleResult.ok) {
    log("\nAudit EN ECHEC - corriger les points ci-dessus avant de publier une nouvelle version.");
    process.exitCode = 1;
  } else {
    log("\nAudit OK.");
  }
}

main();
