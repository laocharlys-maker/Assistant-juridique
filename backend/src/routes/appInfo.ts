import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { appRoot } from "../lib/seaPaths";

export const appInfoRouter = Router();

/**
 * GET /api/app-info - toujours accessible (comme /health et
 * /api/network-info), aucune authentification requise : sert a l'ecran
 * "A propos" (Lot 8, "bonnes pratiques" - numero de version visible dans
 * l'app). Lit directement package.json plutot que de dupliquer une
 * constante, pour ne jamais desynchroniser l'affichage du vrai numero de
 * version buildee (voir aussi src-tauri/tauri.conf.json et Cargo.toml,
 * qui doivent etre tenus au meme numero a chaque release - voir
 * README-LOT8.md "Versionner une nouvelle release").
 */
appInfoRouter.get("/api/app-info", (_req, res) => {
  let version = "0.0.0-inconnue";
  try {
    const raw = fs.readFileSync(path.join(appRoot(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    version = pkg.version || version;
  } catch {
    // Absent en mode "npm run dev" hors packaging SEA (appRoot() pointe
    // alors vers un dossier different) - jamais bloquant, l'ecran "A
    // propos" affiche simplement la version par defaut dans ce cas.
  }
  res.json({ version, editeur: "AzoMedIA" });
});
