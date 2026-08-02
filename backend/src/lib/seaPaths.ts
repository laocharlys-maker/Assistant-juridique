import path from "node:path";

/**
 * Racine "application" utilisee pour resoudre les chemins vers les fichiers
 * statiques (public/, uploads/) et les dependances natives (Prisma).
 *
 * En temps normal (npm run dev / npm start), __dirname pointe vers un
 * fichier reel sur disque et fonctionne nativement.
 *
 * Quand ce code tourne empaquete dans un executable Node SEA
 * (voir scripts/build-sea.js), tout le bundle est concatene dans un seul
 * fichier : __dirname ne correspond alors plus a l'emplacement d'origine de
 * chaque module source. On resout donc la racine explicitement :
 * - AURORE_APP_ROOT est positionne par le sidecar Tauri (src-tauri/src/main.rs)
 *   pour pointer vers le dossier de ressources ou ont ete copies
 *   public/, node_modules/ (client Prisma) et .env ;
 * - a defaut (test du binaire SEA en ligne de commande, sans Tauri), on
 * utilise le dossier contenant l'executable lui-meme.
 */
export function appRoot(): string {
  if (process.env.AURORE_APP_ROOT) {
    return process.env.AURORE_APP_ROOT;
  }

  let isSea = false;
  try {
    // node:sea est disponible a partir de Node 20.12 / 21.7 (experimental).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sea = require("node:sea");
    isSea = typeof sea.isSea === "function" && sea.isSea();
  } catch {
    isSea = false;
  }

  if (isSea) {
    return path.dirname(process.execPath);
  }

  // Mode normal (tsx watch, ou node dist/index.js) : ce fichier compile vit
  // dans dist/lib/seaPaths.js, la racine applicative (contenant public/) est
  // deux niveaux au-dessus.
  return path.join(__dirname, "..", "..");
}
