import { vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Setup global Vitest (voir vitest.config.ts, `test.setupFiles`) - charge
 * automatiquement avant CHAQUE fichier de test, jamais par le binaire
 * desktop livre.
 *
 * Remplace, uniquement dans le graphe de modules du PROCESSUS DE TEST, la
 * cle publique de PRODUCTION embarquee dans config/licencePublicKey.ts par
 * la cle publique de TEST du Lot 3 (test-keys/licence-test-public.pem) -
 * ce qui permet aux tests (tests/e2e/helpers/testLicence.ts et al.) de
 * continuer a signer des licences avec test-keys/licence-test-private.pem
 * et de les faire verifier avec succes par le vrai code de production
 * (security/licenceManager.ts), SANS jamais modifier ce code ni la cle
 * qu'il embarque reellement.
 *
 * ============================================================================
 * GARANTIE DE SEPARATION TEST / PRODUCTION (a verifier en cas de doute) :
 * ============================================================================
 *
 * 1. Ce fichier vit sous backend/tests/, hors de backend/tsconfig.json
 *    (`include: ["src"]`, voir ce fichier) - `npm run build` (tsc) ne le
 *    compile JAMAIS. Il n'existe donc dans AUCUN artefact livre (dist/,
 *    dist-sea/, le binaire SEA embarque par l'installeur Tauri) : verifiable
 *    par `grep -r "licence-test" dist-sea/` (rien) apres un build reel, ou
 *    en lisant scripts/build-sea.js (le bundle esbuild part de dist/index.js
 *    et ne peut atteindre aucun fichier sous tests/, qui n'a jamais ete
 *    compile dans dist/ en premier lieu).
 *
 * 2. config/licencePublicKey.ts n'est PAS modifie par ce mecanisme : son
 *    contenu SOURCE reste, sur disque et dans git, la vraie cle de
 *    production, integralement inchangee. Seul le PROCESSUS Vitest, en
 *    memoire, substitue le module au moment de l'import (`vi.mock`
 *    ci-dessous) - un `git show HEAD:backend/src/config/licencePublicKey.ts`
 *    ou une lecture directe du fichier montre toujours la cle de
 *    production, jamais celle de test, y compris pendant qu'une suite de
 *    tests tourne.
 *
 * 3. Aucune variable d'environnement (NODE_ENV ou autre) n'est lue par
 *    security/licenceManager.ts ni config/licencePublicKey.ts pour decider
 *    QUELLE cle utiliser - verifiable par `grep -n "process.env"
 *    src/security/licenceManager.ts src/config/licencePublicKey.ts` (aucune
 *    occurrence liee au choix de la cle). Le point de bascule est
 *    entierement STRUCTUREL (quel fichier tourne reellement : vitest via ce
 *    setup, ou node dist/index.js / le binaire SEA), jamais une condition
 *    evaluee au runtime du binaire livre - donc jamais quelque chose qu'un
 *    utilisateur final pourrait declencher en definissant une variable
 *    d'environnement sur son poste.
 *
 * En clair : il n'existe littéralement aucun chemin de code, dans le
 * binaire desktop reellement distribue, qui sache que test-keys/ existe.
 */
const testPublicKeyPem = fs.readFileSync(
  path.join(__dirname, "..", "test-keys", "licence-test-public.pem"),
  "utf8"
);

vi.mock("../src/config/licencePublicKey", () => ({
  LICENCE_PUBLIC_KEY_PEM: testPublicKeyPem,
  LICENCE_PUBLIC_KEY_IS_TEST_PLACEHOLDER: true,
}));
