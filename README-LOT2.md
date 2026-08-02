# Lot 2 — PostgreSQL portable + installation/désinstallation propre

Remplace la connexion VPS en dur (Lot 1) par un cluster PostgreSQL 16
portable, embarqué dans l'installeur, initialisé au premier lancement et
piloté par le même sidecar Tauri — pour un fonctionnement 100% local, sans
VPS, en mode standalone. Prisma continue de se connecter via une simple
`DATABASE_URL` : aucune requête ni le schéma n'ont été modifiés.

## Contrairement au Lot 1 : ce qui a été réellement testé ici

Ce lot a été développé avec un accès réseau complet et une machine Windows
réelle, ce qui a permis de télécharger les **vrais binaires PostgreSQL**,
de lancer **de vrais** `initdb`/`pg_ctl`/`psql`/`pg_dump`/`pg_restore`, et
de faire tourner **le vrai binaire SEA** (issu du Lot 1) en mode
`DATABASE_MODE=portable` de bout en bout : initialisation du cluster,
création du rôle applicatif et de la base, application du schéma, démarrage
réel d'Express avec une connexion Prisma réelle sur `/health`
(`{"status":"ok","database":"connected"}`), planification du backup,
puis **arrêt gracieux complet** (Express → Prisma → `pg_ctl stop -m fast`)
en ~3,7 s, sans process orphelin ni fichier de lock résiduel.

**Seule pgvector n'a pas pu être testée** : sa compilation nécessite Visual
Studio Build Tools (MSVC), absent de cet environnement — exactement comme
Rust/Cargo l'était pour le Lot 1. Le reste de ce document distingue
clairement ce qui a été vérifié de ce qui reste à valider avec le
toolchain complet.

## Distribution de binaires retenue

**EnterpriseDB "Windows binaries" (zip, sans installeur)**, PAS
`zonkyio/embedded-postgres-binaries` initialement envisagé.

Vérifié empiriquement en téléchargeant les deux :
- `io.zonky.test.postgres:embedded-postgres-binaries-windows-amd64` (Maven
  Central) est réel et maintenu, mais conçu pour des tests Java embarqués :
  son `bin/` ne contient QUE `postgres.exe`, `initdb.exe`, `pg_ctl.exe` — ni
  `pg_dump`, ni `pg_restore`, ni `psql`, ni `pg_isready`, pourtant
  nécessaires ici (sauvegardes, provisionnement SQL, health-check réel).
- Le zip officiel EDB (`get.enterprisedb.com/postgresql/postgresql-<version>-windows-x64-binaries.zip`,
  même binaire que l'installeur Windows officiel de postgresql.org, sans
  installeur ni pgAdmin/StackBuilder une fois ces dossiers exclus) contient
  l'outillage complet : `psql`, `pg_dump`, `pg_restore`, `pg_isready`,
  `createdb`, ainsi que les en-têtes de compilation (`include/server/`) et
  la lib d'import (`lib/postgres.lib`) nécessaires à pgvector (voir
  ci-dessous). Téléchargé et testé en réel pendant ce lot (338 Mo
  compressés ; ~124 Mo une fois `pgAdmin 4/`, `doc/`, `StackBuilder/` et
  `include/` retirés du résultat final).

Version épinglée : `16.14-1` (`AURORE_PG_VERSION` dans
`download-postgres-binaries.js` pour changer).

## Contournement pgvector

**pgvector ne publie aucun binaire précompilé pour Windows** — vérifié via
l'API GitHub : `repos/pgvector/pgvector/releases` renvoie une liste vide,
quelle que soit la plateforme. La seule voie documentée (README officiel du
projet) est la compilation via `nmake /F Makefile.win`, avec Visual Studio
Build Tools ("x64 Native Tools Command Prompt") et une variable `PGROOT`
pointant vers une installation PostgreSQL complète (en-têtes + lib
d'import).

`backend/scripts/download-postgres-binaries.js` automatise exactement
cette procédure au moment du build de l'installeur :
1. Télécharge/extrait le zip EDB (avec ses `include/`/`lib/postgres.lib`).
2. Détecte Visual Studio via `vswhere.exe` (composant "Desktop development
   with C++") — **échoue avec un message explicite et actionnable si
   absent**, plutôt que de dégrader silencieusement la fonctionnalité RAG
   jurisprudence (consigne explicite du lot).
3. Clone `pgvector` (tag épinglé, `AURORE_PGVECTOR_TAG`, défaut `v0.8.0`)
   et lance `nmake /F Makefile.win` avec `PGROOT` pointant vers les
   en-têtes extraits.
4. Copie `vector.dll` → `lib/`, `vector.control` + `vector--*.sql` →
   `share/extension/` dans la distribution finale.
5. Retire ensuite `include/`, `doc/`, `StackBuilder/`, `pgAdmin 4/` du
   résultat (inutiles au runtime, seul `include/` servait à l'étape 3).

**Non testé dans cet environnement** (pas de Visual Studio Build Tools
installé) : la compilation elle-même. Tout le reste du pipeline
(téléchargement, cache, extraction, exclusions, détection MSVC) a été
exécuté pour de vrai — seule l'étape `nmake` n'a pas pu aller à son terme
ici. **À faire avant mise en production** : lancer
`npm run postgres:download-binaries` sur une machine Windows avec Visual
Studio Build Tools installé, et vérifier que `vector.dll` apparaît bien
dans `backend/vendor/postgres/win-x64/lib/`.

## Architecture

Deux responsabilités séparées, comme demandé :

- **`backend/src/database/initCluster.ts`** — première initialisation
  uniquement (idempotente) : `initdb`, génération des identifiants,
  création du rôle applicatif dédié et de la base, application de
  `prisma/portable-init.sql` (contient `CREATE EXTENSION vector` + tout le
  schéma), octroi des privilèges. Écrit un **marqueur**
  (`pgdata/.aurore-provisioned`) uniquement après succès complet — voir
  "Bugs découverts" ci-dessous pour pourquoi c'est nécessaire.
- **`backend/src/database/postgresPortable.ts`** — cycle de vie courant
  d'un cluster déjà initialisé : démarrage (`pg_ctl start`), arrêt propre
  (`pg_ctl stop -m fast`), health-check réel (`pg_isready`, pas de délai
  fixe).
- **`backend/src/database/credentialsStore.ts`** — génération (aléatoire,
  `crypto.randomBytes`) et stockage des identifiants dans
  `%APPDATA%/Aurore/secrets/db-credentials.json` (permissions restreintes à
  l'utilisateur courant via `icacls`) — même emplacement que la future clé
  de chiffrement du Lot 2bis. Jamais loggés, jamais en dur.
- **`backend/src/database/portablePaths.ts`** — tous les chemins
  (data dir, logs, secrets, backups, binaires) centralisés en un seul
  endroit, réutilise `appRoot()` du Lot 1 (`backend/src/lib/seaPaths.ts`)
  pour localiser les binaires Postgres embarqués de la même façon que
  `node_modules`/`public` au Lot 1.
- **`backend/src/database/bootstrapPortableDatabase.ts`** — glue : appelle
  `ensureClusterInitialized` puis `startPortablePostgres`, retourne la
  `DATABASE_URL` calculée. Conçu pour être réutilisable tel quel par le Lot
  6 (mode réseau) sur le poste serveur, avec un `host` différent
  (0.0.0.0/IP LAN au lieu de 127.0.0.1) plutôt que réécrit.
- **`backend/src/database/backupScheduler.ts`** — `pg_dump -F c` planifié
  via `node-cron` (même mécanisme que la veille juridique/rétention déjà
  dans le projet), purge des sauvegardes au-delà de la rétention configurée.
- **`backend/scripts/restore-backup.js`** — restauration manuelle
  (`pg_restore`), CLI documentée ci-dessous, testée en réel.

`backend/src/index.ts` séquence désormais le démarrage : en mode
`DATABASE_MODE=portable`, `bootstrapPortableDatabase()` tourne et positionne
`process.env.DATABASE_URL` **avant** que `./config/env` (validation stricte
via zod) ou `./app` (instancie `PrismaClient`) ne soient chargés — d'où le
passage à des `await import(...)` dynamiques dans `main()` plutôt que des
imports statiques. En mode `externe`/`reseau`, ce module n'est même pas
importé : comportement du Lot 1 strictement inchangé.

## Build

```bash
cd backend
npm install
npm run postgres:download-binaries   # backend/vendor/postgres/win-x64/ (necessite VS Build Tools pour pgvector)
npm run build:sea                    # inclut prisma:generate + prisma:portable-sql + build + copie postgres/
```

`npm run build:sea` (mis à jour pour ce lot) copie désormais aussi
`backend/vendor/postgres/` → `dist-sea/postgres/` et
`backend/prisma/portable-init.sql` → `dist-sea/prisma/portable-init.sql`,
en plus de ce que faisait déjà le Lot 1.

Depuis la racine (`npm run tauri:build`), `tauri.conf.json` copie ces deux
dossiers dans les ressources de l'app au même titre que `public/`/
`node_modules/` (Lot 1), et `src-tauri/src/main.rs` positionne désormais
`DATABASE_MODE=portable` au lancement du sidecar (la coquille desktop est
toujours en mode standalone).

## Test manuel (ce qui a été vérifié pendant ce lot)

```bash
cd backend
npm run build:sea
cd dist-sea
# .env minimal : DATABASE_MODE=portable, PORT, HOST, SESSION_SECRET, LLM_PROVIDER+cle
./aurore-backend.exe
```

Premier lancement (log attendu, vérifié en réel) :
```
[postgres-init] premiere initialisation du cluster portable (...)
[postgres-credentials] identifiants generes et stockes dans ...db-credentials.json
[postgres-init] initdb...
[postgres-init] demarrage temporaire pour provisionnement...
[postgres-portable] connexion confirmee (tentative 1/60).
[postgres-init] creation du role applicatif dedie...
[postgres-init] creation de la base "aurore"...
[postgres-init] activation de pgvector et mise en place du schema applicatif...
[postgres-init] cluster initialise avec succes.
[postgres-portable] arrete proprement...
[postgres-portable] connexion confirmee (tentative 1/60).
Aurore backend demarre sur 127.0.0.1:3000 (production)
```
`curl http://127.0.0.1:3000/health` → `{"status":"ok","database":"connected"}`.

Relancer l'app : `[postgres-init] cluster deja initialise, rien a faire.`
puis démarrage direct (pas de re-initialisation) — vérifié, quelques
secondes.

Fermer l'app (Ctrl+C, ou écrire `shutdown` sur stdin comme le fait le
sidecar Tauri) : `pg_ctl stop -m fast` s'exécute, `pgdata/postmaster.pid`
disparaît, aucun `postgres.exe` ne reste dans le gestionnaire de tâches
(vérifié avec `tasklist`), et l'app suivante redémarre normalement sans
corruption.

## Sauvegarde et restauration

**Sauvegarde automatique** : planifiée via `POSTGRES_BACKUP_CRON` (défaut
`0 3 * * *`, tous les jours à 3h, fuseau Africa/Porto-Novo comme les autres
jobs du projet), fichiers `.dump` (format `pg_dump -F c`, compressé) dans
`%APPDATA%/Aurore/backups/`, purgés au-delà de `POSTGRES_BACKUP_RETENTION`
(défaut 14). Testé manuellement en réel (`runBackupNow()` équivalent via
`pg_dump` direct) : fichier `.dump` valide généré, restauré avec succès sur
une base fraîche via `pg_restore`.

**Restauration manuelle** (`backend/scripts/restore-backup.js`, non exposée
dans l'UI pour ce lot, testée en réel pendant ce lot) :

```bash
cd backend
# Restaure dans la base configuree, en l'ecrasant completement :
node scripts/restore-backup.js "%APPDATA%\Aurore\backups\aurore-2026-08-01T12-00-00-000Z.dump" --drop

# Ou vers une base de test, sans toucher a la base existante :
node scripts/restore-backup.js chemin\vers\sauvegarde.dump --database=aurore_test
```

Sur un **nouveau poste** (PC remplacé) : copier d'abord le dossier complet
`%APPDATA%\Aurore` (identifiants + data directory) depuis une sauvegarde du
poste précédent si disponible, sinon relancer l'app une première fois pour
qu'elle réinitialise un cluster neuf, puis restaurer par-dessus avec
`--drop`. Le script refuse de tourner sans le fichier d'identifiants
(`db-credentials.json`) et l'explique clairement.

## Désinstallation (coordination avec le Lot 8)

Ce lot ne supprime jamais de données de lui-même. `pg_ctl stop -m fast` est
la seule opération destructive-adjacente qu'il déclenche (arrêt propre, pas
suppression). Le choix de conserver ou supprimer `%APPDATA%/Aurore`
(données + identifiants + sauvegardes) à la désinstallation revient au Lot
8, qui doit se contenter d'appeler `stopPortablePostgres()` avant toute
suppression de fichiers pour éviter de supprimer un data directory encore
monté.

## Bugs découverts et corrigés pendant ce lot (empiriquement)

Trois problèmes réels, non anticipés par la documentation Node/Postgres
consultée au préalable, découverts en faisant tourner le vrai binaire (pas
seulement en le codant) :

### a) `pg_ctl start` bloquait indéfiniment Node

`execFile`/`execFileAsync` (API callback/promesse de `child_process`)
utilisent toujours des pipes pour stdout/stderr, sans option pour changer
ça. `pg_ctl start` démarre `postgres.exe` (et ses processus auxiliaires -
checkpointer, bgwriter, walwriter...) comme processus **persistants** qui
héritent de ces pipes. Node attend leur fermeture (EOF) pour résoudre la
promesse — qui n'arrive jamais tant que Postgres tourne, donc jamais.
Reproduit avec un script minimal isolé, confirmé par le log Postgres
lui-même montrant un démarrage en moins d'une seconde pendant que Node
restait bloqué 40+ secondes. **Correction** : `execFileSync` avec
`stdio: "ignore"` (la seule API `child_process` qui supporte réellement
l'option `stdio`) pour `pg_ctl start`/`stop` spécifiquement — le vrai signal
de disponibilité vient de toute façon de `waitUntilReady()` (`pg_isready`),
pas de la sortie texte de `pg_ctl`.

### b) `pdfkit` copié sans ses propres dépendances (regression latente du Lot 1)

`pdfkit` déclare 6 dépendances npm (`@noble/hashes`, `@noble/ciphers`,
`fontkit`, `js-md5`, `linebreak`, `png-js`, elles-mêmes avec des
sous-dépendances, dont une imbriquée -
`linebreak/node_modules/base64-js`). Le Lot 1 ne copiait que le dossier
`node_modules/pdfkit` lui-même dans `dist-sea/`, jamais exercé jusqu'à ce
que ce lot fasse réellement charger `app.ts` avec succès (Postgres prêt) :
`Cannot find module '@noble/hashes/utils'` au démarrage. **Correction** :
`build-sea.js` calcule maintenant la fermeture réelle des dépendances en
**requérant réellement** chaque paquet externe dans un process jetable et
en inspectant `require.cache`, plutôt que de deviner via les
`package.json` — gère correctement les cas de nesting.

### c) Initialisation partielle indétectable

Si le provisionnement échoue en cours de route (ex : pgvector absent du
build), `initdb` a déjà tourné (`PG_VERSION` existe) et les identifiants
sont déjà stockés : sans précaution, un redémarrage aurait considéré le
cluster comme "prêt" et démarré Express contre une base sans aucune table.
**Correction** : un marqueur (`pgdata/.aurore-provisioned`) n'est écrit
qu'après le tout dernier `GRANT` réussi ; son absence malgré un cluster
existant fait échouer le démarrage avec un message explicite plutôt que de
continuer silencieusement (vérifié en réel : reproduit puis corrigé). De
même, un échec **après** le démarrage de Postgres (n'importe laquelle des
étapes suivantes) déclenche désormais `stopPortableDatabase()` avant de
quitter — sans ce filet, un `postgres.exe` restait orphelin en arrière-plan
(vérifié en réel via `tasklist`).

## Limites connues / suite

- **pgvector non compilé/testé ici** (pas de Visual Studio Build Tools) —
  voir "Contournement pgvector" ci-dessus. La requête de similarité
  vectorielle sur `JurisprudenceChunk` (critère de test du lot) n'a donc
  pas pu être exécutée dans cet environnement.
- **Intégration Tauri réelle non testée** (même limite qu'au Lot 1 : pas de
  Rust/Cargo ici). Les changements à `src-tauri/src/main.rs`
  (`DATABASE_MODE=portable`, délai d'arrêt à 10s) et `tauri.conf.json`
  (ressources `postgres/`+`prisma/`) sont écrits mais pas compilés.
- **`.env` (avec les identifiants VPS d'un mode "externe" eventuel)
  toujours embarqué en clair dans les ressources de l'app** si présent
  (hérité du Lot 1) — en mode portable, ce fichier ne contient plus de
  secret DB critique (DATABASE_URL n'y est pas utilisée), mais
  `SESSION_SECRET` et les clés API LLM y restent en clair. Hors périmètre
  de ce lot (le Lot 2bis, sur le stockage sécurisé des secrets, en
  dépend explicitement).
- **Linux/macOS non testés** (Windows priorisé comme demandé) :
  `portablePaths.ts` a un repli `darwin`/`linux` mais
  `download-postgres-binaries.js` ne définit que `win-x64` dans
  `PLATFORMS` pour l'instant.
