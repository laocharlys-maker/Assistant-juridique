import path from "node:path";

const WINDOWS_EXTENDED_LENGTH_PREFIX = "\\\\?\\";
const WINDOWS_EXTENDED_LENGTH_UNC_PREFIX = "\\\\?\\UNC\\";

/**
 * Windows uniquement : `resource_dir()` de Tauri (AURORE_APP_ROOT, positionne
 * dans src-tauri/src/main.rs) peut renvoyer un chemin "verbatim" prefixe
 * \\?\ (ou \\?\UNC\ pour un partage reseau) - le mecanisme natif Windows
 * pour depasser MAX_PATH (260 caracteres). Ce prefixe exige que TOUT le
 * chemin reste en antislashs litteraux : la moindre manipulation en aval qui
 * introduit des slashs normaux (concatenation de sous-chemin avec "/",
 * path.dirname() applique plusieurs fois par la resolution de module Node...)
 * le corrompt silencieusement.
 *
 * Deux symptomes reels distincts de cette meme cause racine ont ete
 * rencontres : l'initialisation de Postgres portable (initdb.exe casse le
 * prefixe en interne en canonicalisant son propre chemin, \\?\ devient //?/,
 * voir stripWindowsExtendedLengthPrefix dans database/portablePaths.ts,
 * corrige separement avant la decouverte de cette cause commune) et le
 * require() dynamique de pdfkit genere par le shim SEA (voir shimFileSource
 * dans scripts/build-sea.js) : la concatenation `appRoot() + "/node_modules/
 * aurore-sea-shim.js"` corrompait le prefixe jusqu'a ce que la resolution de
 * module de Node finisse par lstat() la racine du disque ("C:") et echoue
 * avec EISDIR.
 *
 * On nettoie donc ici, a la source unique de appRoot() (au lieu de dupliquer
 * ce nettoyage dans chaque consommateur) - tout le reste du code peut
 * continuer a traiter la valeur de appRoot() comme un chemin Windows normal.
 */
function stripWindowsExtendedLengthPrefix(rawPath: string): string {
  if (process.platform !== "win32") {
    return rawPath;
  }
  if (rawPath.startsWith(WINDOWS_EXTENDED_LENGTH_UNC_PREFIX)) {
    return "\\\\" + rawPath.slice(WINDOWS_EXTENDED_LENGTH_UNC_PREFIX.length);
  }
  if (rawPath.startsWith(WINDOWS_EXTENDED_LENGTH_PREFIX)) {
    return rawPath.slice(WINDOWS_EXTENDED_LENGTH_PREFIX.length);
  }
  return rawPath;
}

/**
 * Detecte si ce code tourne empaquete dans un executable Node SEA (voir
 * scripts/build-sea.js), plutot qu'en mode normal (npm run dev / npm start).
 * Extrait ici (au lieu de duplique) car utilise a la fois par appRoot()
 * ci-dessous et par config/env.ts (pour forcer NODE_ENV=production dans le
 * binaire empaquete, peu importe ce qu'un .env local aurait pu positionner
 * au moment du build - voir env.ts).
 */
export function isSea(): boolean {
  try {
    // node:sea est disponible a partir de Node 20.12 / 21.7 (experimental).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sea = require("node:sea");
    return typeof sea.isSea === "function" && sea.isSea();
  } catch {
    return false;
  }
}

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
    return stripWindowsExtendedLengthPrefix(process.env.AURORE_APP_ROOT);
  }

  if (isSea()) {
    return stripWindowsExtendedLengthPrefix(path.dirname(process.execPath));
  }

  // Mode normal (tsx watch, ou node dist/index.js) : ce fichier compile vit
  // dans dist/lib/seaPaths.js, la racine applicative (contenant public/) est
  // deux niveaux au-dessus.
  return path.join(__dirname, "..", "..");
}
