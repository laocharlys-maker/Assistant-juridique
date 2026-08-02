# Lot 1 — Tauri Sidecar + Packaging Node SEA

Empaquette le backend Express/TS/Prisma existant (`backend/`) en executable
autonome (Node SEA), lance comme sidecar par une coquille desktop Tauri v2
minimale. Aucune logique metier n'a ete modifiee — ce lot est uniquement de
l'infrastructure/packaging.

## Prerequis

| Outil | Version | Necessaire pour |
|---|---|---|
| Node.js | >= 20 (teste avec v24.18.1) | `backend:build` (Node SEA) |
| npm | fourni avec Node | tous les scripts |
| Rust + Cargo | stable recente ([rustup.rs](https://rustup.rs)) | `tauri:dev` / `tauri:build` |
| Tauri CLI | v2, installe via `npm install` a la racine (`@tauri-apps/cli`) | `tauri:dev` / `tauri:build` |
| Windows SDK (`signtool`) | **non requis** | le script de build retire lui-meme la signature Authenticode du binaire node copie (voir "Blocages rencontres") |

> **Important — environnement de redaction de ce lot.** Le packaging
> backend/SEA (partie Node) a ete developpe **et teste de bout en bout**
> (build, lancement du binaire seul, `/health`, fichiers statiques, arret
> propre). La partie Rust/Tauri (`src-tauri/`) a ete ecrite selon les
> conventions Tauri v2 mais **n'a pas pu etre compilee ni executee** :
> l'environnement de developpement ne dispose ni de Rust/Cargo ni du Tauri
> CLI. Il faudra lancer `npm install` puis `npm run tauri:dev` (ou
> `tauri:build`) dans un environnement avec Rust installe pour corriger
> d'eventuelles erreurs de compilation (noms de methodes API Tauri qui
> auraient legerement change entre versions 2.x, syntaxe exacte des
> permissions dans `capabilities/default.json`, etc.) avant mise en
> production.

## Build

```bash
# 1. Backend -> executable Node SEA autonome (backend/dist-sea/)
cd backend
npm install
npm run build:sea
cd ..

# 2. Coquille desktop (depuis la racine du depot)
npm install
npm run tauri:build   # ou npm run tauri:dev pour le mode developpement
```

`npm run tauri:build` (racine) enchaine automatiquement :
1. `backend:build` → `npm --prefix backend run build:sea`
2. `sidecar:prepare` → copie `backend/dist-sea/aurore-backend.exe` vers
   `src-tauri/binaries/aurore-backend-<target-triple>.exe` (convention de
   nommage des sidecars Tauri)
3. `tauri build` (ou `tauri dev`)

Pas d'etape manuelle cachee : un `rm -rf backend/dist backend/dist-sea
src-tauri/target src-tauri/binaries` suivi de la sequence ci-dessus doit
tout reproduire.

### `backend/scripts/build-sea.js` en detail

1. Bundle `dist/index.js` (sortie de `tsc`) en un seul fichier CJS via
   esbuild, avec un plugin maison qui neutralise deux incompatibilites
   Node SEA propres a ce projet (voir "Blocages rencontres").
2. Genere le blob SEA (`node --experimental-sea-config`).
3. Copie le binaire `node` courant, lui retire sa signature Authenticode
   (patch direct du header PE, sans dependre de `signtool`), puis y injecte
   le blob via `postject`.
4. Copie a cote de l'executable produit (`backend/dist-sea/`) : `public/`,
   `.env`, et le sous-ensemble de `node_modules/` necessaire au runtime
   (`@prisma/client`, `.prisma/client` — moteur natif inclus —, `pdfkit`).

## Tests manuels

### 1. Binaire seul (sans Tauri)

```bash
cd backend/dist-sea
cp ../.env .env   # ou un .env de test avec DATABASE_URL/SESSION_SECRET valides
./aurore-backend.exe        # Windows
# ./aurore-backend           # macOS/Linux (chmod +x deja applique par le build)
```

Dans un autre terminal :

```bash
curl http://127.0.0.1:3000/health
# {"status":"ok","database":"connected"}  (ou "degraded" si la DB VPS n'est pas joignable)
```

**Verifie ici** (build + tests reellement executes pendant ce lot) : le
binaire demarre, sert `/health`, sert les fichiers statiques de `public/`
(`index.html`, `login.html`, `js/api.js` → 200) et repond correctement sur
les routes API (`/api/auth/me` → 401 attendu sans session). Arret propre
teste en ecrivant `shutdown` sur le stdin du process : sortie en ~1,2s avec
code 0 (fermeture HTTP server + `prisma.$disconnect()`).

### 2. Cycle de vie via Tauri

*(a verifier dans un environnement avec Rust/Tauri installes — non testable
ici)*

1. `npm run tauri:dev` (ou lancer l'app buildee).
2. Verifier dans le gestionnaire de taches qu'un process
   `aurore-backend.exe` apparait peu apres le lancement.
3. La fenetre affiche l'ecran de chargement (`src-tauri/loading/index.html`)
   puis bascule automatiquement sur l'interface reelle une fois
   `/health` OK.
4. Fermer la fenetre : le process `aurore-backend.exe` doit recevoir la
   commande d'arret via stdin et disparaitre du gestionnaire de taches sous
   3 a 5 secondes (voir `SHUTDOWN_GRACE_MS` dans `src-tauri/src/main.rs`).

### 3. Test fonctionnel minimal (login)

Renseigner `backend/.env` avec les vraies informations de connexion au VPS
(`DATABASE_URL`, `SESSION_SECRET`, etc. — voir `.env.example`), relancer le
build, puis depuis la fenetre Tauri (ou un navigateur pointe sur
`http://127.0.0.1:3000`) tenter une connexion avec un compte existant.

*Non teste dans cette session* : pas d'acces aux identifiants de la base
VPS de production. Le routage HTTP, le service des fichiers statiques et le
comportement de l'API sans session ont en revanche ete verifies (voir
section 1).

## Blocages rencontres avec Node SEA (et contournements)

Trois problemes reels ont ete decouverts en testant effectivement le
binaire produit (pas seulement en le construisant) — les deux premiers
n'etaient pas anticipes par la documentation Node SEA consultee au
prealable :

### a) `__dirname` ne correspond plus a rien d'utile une fois bundle

esbuild fige `__dirname`/`__filename` a la valeur **absolue du fichier
source au moment du build** (verifie empiriquement — ce n'est ni la valeur
du fichier de sortie, ni une valeur recalculee au runtime). Une fois ce
chemin absolu (propre a la machine de build) embarque dans l'executable
final, `express.static(path.join(__dirname, "..", "public"))` (dans
`app.ts`) et les dossiers d'upload (`cabinet.ts`, `signature.ts`,
`documentExport.ts`) pointent vers un dossier qui n'existe pas chez
l'utilisateur final.

**Contournement** : `backend/src/lib/seaPaths.ts` (nouveau fichier) expose
`appRoot()`, qui resout la racine applicative via la variable
d'environnement `AURORE_APP_ROOT` (positionnee par le sidecar Tauri) ou, a
defaut (test du binaire en CLI), via le dossier de l'executable
(`process.execPath`). Le script de build reecrit — **uniquement dans le
code compile issu de notre propre `src/`, jamais dans `node_modules`**
(voir point c) — chaque usage de `__dirname` par un appel a `appRoot()`.
Aucun fichier source (`.ts`) n'est modifie par cette etape : la
transformation s'applique au JS compile (`dist/`), a la volee, pendant le
bundling.

### b) `require()` d'un paquet npm echoue depuis le code embarque dans le blob SEA

Meme en passant un **chemin absolu** calcule au runtime, `require(...)`
depuis le code du blob SEA echoue avec
`ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: ...` : Node route
tout `require()` fait depuis le script principal embarque via un
"embedderRequire" qui ne resout que les modules natifs, sans repli sur la
resolution `node_modules` habituelle — **quel que soit** l'argument
(specifier nu ou chemin absolu). Verifie empiriquement avec un cas de test
isole avant d'etre applique au projet.

**Contournement** : `require("node:module").createRequire(cheminReel)`
echappe a cette restriction (confirme par un test isole : chargement d'un
fichier local puis d'un paquet `node_modules` reussis tous les deux via
`createRequire`, la ou `require()` simple echoue dans les deux cas). Le
plugin esbuild du script de build reecrit donc les `require("@prisma/client")`
et `require("pdfkit")` (les deux seuls paquets a acces disque au runtime -
moteur Prisma natif et polices AFM de pdfkit, voir point c) en appels via
un `createRequire` construit a partir de `appRoot()`.

### c) Prisma (moteur natif) et pdfkit (polices) ne peuvent pas etre "inlines"

`@prisma/client` embarque un moteur de requetes natif
(`query_engine-*.node`) : impossible a inclure comme texte JS dans un
bundle. `pdfkit` lit ses fichiers de polices (`.afm`) et son profil couleur
(`.icc`) via `fs.readFileSync(__dirname + "/data/...")` a l'execution — un
audit de toutes les dependances du projet (`grep __dirname` sur chaque
paquet de `node_modules`) confirme que ce sont les **deux seules**
dependances concernees (les occurrences trouvees ailleurs, ex. `mammoth`,
`bcryptjs`, ne concernent que leurs scripts de build/tests, jamais le code
charge au runtime).

**Contournement** : les deux paquets sont marques `external` pour esbuild
(non bundles) et leurs dossiers complets sont copies tels quels dans
`backend/dist-sea/node_modules/` a cote de l'executable (voir point b pour
comment ils sont ensuite charges depuis le blob). Le binaire reste
"autonome" au sens ou il n'a besoin d'aucun `node_modules` du **projet**
(les centaines de paquets de dev/build) — seulement de ce sous-ensemble
minimal, delibrement copie et documente, exactement comme anticipe par le
brief pour Prisma.

### d) Signature Authenticode du binaire `node.exe` + valeur du "sentinel fuse"

Sur Windows, le `node.exe` officiel est signe : `postject` refuse d'y
injecter le blob tant que la signature n'est pas retiree. La procedure
documentee utilise `signtool` (Windows SDK), **absent par defaut** de la
plupart des machines de developpement (dont celle utilisee ici). Par
ailleurs, la valeur du "sentinel fuse" couramment citee dans la
documentation (`NODE_SEA_FUSE_fce680ab-2cc467b5-b6e075f4-31af79b2`) ne
correspondait pas a celle reellement presente dans le binaire Node 24
utilise ici.

**Contournement** : `stripWindowsSignature()` dans `build-sea.js` retire la
signature en patchant directement l'en-tete PE (met a zero l'entree
"Certificate Table" des Data Directories puis tronque le fichier) — aucune
dependance au Windows SDK. `findSentinelFuse()` extrait la vraie valeur du
sentinel directement du binaire copie avant d'appeler `postject`, plutot
que de coder en dur une valeur susceptible de varier selon la version de
Node utilisee pour builder.

## Autres decisions notables

- **`HOST` configurable, defaut inchange.** Le brief demandait de binder
  strictement sur `127.0.0.1`. Forcer cette valeur en dur aurait casse le
  deploiement VPS actuel (`app.ts` mentionne explicitement un reverse proxy
  Traefik, qui a besoin que le process ecoute sur toutes les interfaces).
  `backend/src/config/env.ts` expose donc une variable `HOST`
  (defaut `0.0.0.0`, comportement identique a aujourd'hui), et c'est le
  sidecar Tauri qui positionne explicitement `HOST=127.0.0.1` au lancement
  (`src-tauri/src/main.rs`). Aucune modification du `.env` du VPS n'est
  necessaire.
- **Arret propre via stdin, pas un signal OS.** Windows ne propage pas
  SIGTERM de facon fiable a un process enfant. Le sidecar ecrit
  `"shutdown\n"` sur le stdin du process backend (`CommandChild::write`
  cote Rust) ; `backend/src/index.ts` l'intercepte pour fermer le serveur
  HTTP puis appeler `prisma.$disconnect()` avant de quitter. Un
  `SIGINT`/`SIGTERM`/`SIGBREAK` est egalement gere pour le cas du test en
  ligne de commande (Ctrl+C).

## Limites connues / suite

- **Icones Tauri** : `src-tauri/icons/` contient des copies directes des
  favicons existants (`backend/public/favicon.ico`, `favicon-256.png`), pas
  le jeu complet de tailles habituellement genere par `cargo tauri icon
  <source>`. A regenerer proprement des que le Tauri CLI est disponible.
- **`capabilities/default.json`** : la syntaxe exacte des permissions du
  plugin shell (sidecar) a legerement evolue au fil des betas de Tauri v2.
  Le fichier fourni (`core:default` + `shell:allow-execute`) est ma
  meilleure estimation au moment de la redaction, a valider/ajuster au
  premier `cargo build`.
- **`.env` embarque dans l'installeur.** Pour ce lot (connexion VPS en
  dur, comme demande), `.env` est copie tel quel dans les ressources de
  l'app Tauri (`bundle.resources` dans `tauri.conf.json`), donc distribue
  en clair avec l'installeur desktop. Acceptable pour ce lot puisque
  explicitement hors-perimetre ("la base Postgres reste celle du VPS...
  connexion en dur via `.env`, comme aujourd'hui"), mais a traiter avant
  toute distribution reelle (stockage securise des secrets, cote client).
- **Fermeture de fenetre bloque brievement le thread principal** (jusqu'a
  `SHUTDOWN_GRACE_MS` = 3s) le temps de laisser le sidecar se fermer.
  Acceptable pour ce lot (coherent avec de nombreux exemples Tauri), mais
  pourrait etre rendu asynchrone (empecher la fermeture, attendre
  l'evenement `Terminated` du sidecar, puis fermer reellement) dans un lot
  ulterieur si la latence percue au clic sur "Fermer" pose probleme.
- **Test fonctionnel login** non execute faute d'acces a la base VPS de
  production depuis cet environnement (voir section "Tests manuels").
