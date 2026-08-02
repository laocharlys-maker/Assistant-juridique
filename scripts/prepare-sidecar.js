#!/usr/bin/env node
// Copie l'executable Node SEA du backend (backend/dist-sea/aurore-backend[.exe])
// vers src-tauri/binaries/ en respectant la convention de nommage des
// sidecars Tauri : <nom>-<target-triple>[.exe]. Tauri exige ce suffixe pour
// savoir quel binaire embarquer selon la plateforme de build.
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BACKEND_DIST_SEA = path.join(ROOT, "backend", "dist-sea");
const TAURI_BINARIES = path.join(ROOT, "src-tauri", "binaries");

function hostTriple() {
  try {
    const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
    const match = output.match(/host:\s*(\S+)/);
    if (match) return match[1];
  } catch {
    // rustc absent ou hors du PATH
  }
  throw new Error(
    "Impossible de determiner le target triple (`rustc -vV` a echoue). Installe Rust (https://rustup.rs) avant de lancer ce script."
  );
}

function main() {
  const exeName = process.platform === "win32" ? "aurore-backend.exe" : "aurore-backend";
  const source = path.join(BACKEND_DIST_SEA, exeName);
  if (!fs.existsSync(source)) {
    throw new Error(
      `${source} introuvable. Lance d'abord "npm run backend:build" (equivalent a "npm --prefix backend run build:sea").`
    );
  }

  const triple = hostTriple();
  fs.mkdirSync(TAURI_BINARIES, { recursive: true });
  const ext = process.platform === "win32" ? ".exe" : "";
  const target = path.join(TAURI_BINARIES, `aurore-backend-${triple}${ext}`);
  fs.copyFileSync(source, target);
  console.log(`[prepare-sidecar] ${source} -> ${target}`);
}

main();
