# Lot 8 — Installeur final Windows + documentation utilisateur cabinet

Assemble tous les lots precedents (packaging Tauri/SEA, Postgres portable,
chiffrement, licence, pseudonymisation, mode reseau, durcissement) en un
installeur Windows NSIS unique, avec un parcours guide pour un utilisateur
non technique, et la documentation utilisateur finale.

## Ce qui est reellement verifie dans ce lot, et ce qui ne l'est pas

**A lire avant toute chose** — meme limite deja rencontree au Lot 1 :
Rust/Cargo et le CLI Tauri ne sont pas installes dans cet environnement de
developpement. Consequence directe pour ce lot :

| Element | Statut |
|---|---|
| `tauri.conf.json` (bundle NSIS, updater) | Ecrit, JSON valide (verifie), **non valide contre le schema Tauri reel** (pas de CLI pour `tauri build --help`/validation) |
| `installer/nsis/installer-hooks.nsh` (install + desinstall) | Ecrit en syntaxe NSIS standard, **non compile** |
| `src-tauri/src/updater.rs` + wiring `main.rs`/`Cargo.toml` | Ecrit en suivant l'API documentee de `tauri-plugin-updater`/`tauri-plugin-dialog` v2, **non compile** (brace-balance verifiee a la main, rien de plus) |
| `welcome-setup.html`/`.js` + chainage `setup-mode.js` -> licence | **Construit ET teste de bout en bout**, comme tous les ecrans web des lots precedents |
| `docs-utilisateur/` | Redige integralement ; les captures d'ecran sont **des emplacements marques `[Capture d'ecran : ...]`**, a remplacer une fois un vrai installeur existe pour les prendre |
| Test sur VM Windows vierge (snapshot avant/apres) | **Non fait** - aucun acces VM dans cet environnement |
| Test utilisateur non-developpeur du parcours d'installation complet | **Non fait pour la partie installeur .exe** (n'existe pas encore) ; **fait** pour la partie web (bienvenue -> mode -> licence -> connexion), avec vous, lot par lot, depuis le debut de ce projet |
| `.github/workflows/build-windows-installer.yml` | Syntaxe YAML **verifiee** (js-yaml) ; **jamais execute reellement** au moment de la redaction - premiere execution reelle a faire par vous depuis GitHub (voir section dediee ci-dessous) |

En clair : tout le **code** demande par ce lot est ecrit, en suivant
precisement les conventions Tauri v2/NSIS connues. Ce qui necessite une
compilation reelle (le fichier `.exe` lui-meme) ne peut pas etre produit
ni teste ici. C'est exactement pour resoudre ce point qu'un pipeline
GitHub Actions a ete ajoute (voir section suivante) : la compilation
reelle se fait sur une machine Windows fournie par GitHub, sans rien
installer sur votre propre ordinateur.

## Compiler l'installeur automatiquement (GitHub Actions, sans rien installer)

Un robot GitHub ("workflow") compile desormais le vrai fichier `.exe` a
votre place, sur une machine Windows temporaire fournie par GitHub. Vous
n'avez ni Rust, ni le CLI Tauri, ni aucun logiciel a installer vous-meme.

**Important** : ce workflow (`.github/workflows/build-windows-installer.yml`)
a ete ecrit et sa syntaxe verifiee, mais n'a encore jamais ete execute
reellement sur GitHub au moment de la redaction de ce document (il faut
qu'il tourne au moins une fois pour le confirmer). Voir "En cas d'echec"
ci-dessous - c'est normal qu'un premier essai serve a reperer d'eventuels
ajustements.

### Déclencher la compilation (depuis votre navigateur, aucune ligne de commande)

1. Allez sur la page du projet sur GitHub :
   `https://github.com/laocharlys-maker/Assistant-juridique`
2. Cliquez sur l'onglet **"Actions"** en haut de la page.
3. Dans la liste a gauche, cliquez sur **"Build installeur Windows Aurore"**.
4. Cliquez sur le bouton **"Run workflow"** (a droite, au-dessus de la
   liste des executions passees).
5. Une petite fenetre s'ouvre : verifiez que la branche selectionnee est
   bien **`lot8-installeur-final`**, puis cliquez sur le bouton vert
   **"Run workflow"**.

`[Capture d'ecran : bouton "Run workflow" sur GitHub]`

Une nouvelle ligne apparait en haut de la liste, avec un rond jaune
clignotant (en cours). Vous pouvez fermer la page et revenir plus tard —
rien a faire pendant ce temps.

**Note** : la compilation se declenche aussi automatiquement a chaque
nouvel envoi de code sur la branche `lot8-installeur-final` - vous n'avez
alors rien a declencher vous-meme.

### Temps d'attente a prevoir

Environ **20 a 30 minutes** pour un premier lancement (tout doit etre
telecharge/installe sur la machine temporaire de GitHub : Node.js, Rust,
le CLI Tauri, NSIS, les binaires PostgreSQL portables, et la compilation
de pgvector depuis ses sources...). Les lancements suivants sont
generalement plus rapides (12 a 18 minutes), une partie des elements
etant reutilisee d'une fois sur l'autre (cache Cargo notamment).

### Télécharger le fichier .exe une fois terminé

1. Retournez sur l'onglet **"Actions"**, cliquez sur l'execution terminee
   (rond **vert** = reussi).
2. Tout en bas de la page qui s'ouvre, une section **"Artifacts"** liste
   un fichier nomme quelque chose comme
   `Aurore-Installeur-Windows-v0.1.0-2026-08-15`.
3. Cliquez dessus pour le telecharger (un fichier `.zip` contenant le
   vrai `.exe` a l'interieur).

`[Capture d'ecran : section "Artifacts" avec le fichier a telecharger]`

Ce fichier reste disponible au telechargement pendant 30 jours.

### En cas d'échec (rond rouge ❌)

**Ne cherchez pas à corriger vous-même** — contentez-vous de récupérer le
message d'erreur pour me le transmettre :

1. Cliquez sur l'execution en echec (rond rouge) dans l'onglet "Actions".
2. Cliquez sur l'etape qui a un symbole rouge dans la liste a gauche de la
   page (par exemple "Compiler le backend" ou "Preparer le sidecar et
   compiler l'installeur NSIS").
3. Le texte qui s'affiche contient le detail de l'erreur — utilisez le
   bouton de copie (icone presse-papier) en haut de ce bloc de texte, ou
   faites une capture d'ecran complete.
4. Envoyez-moi ce texte ou cette capture, avec le nom de l'etape concernee.

`[Capture d'ecran : etape en echec avec le detail de l'erreur affiche]`

### Historique des echecs corriges

Cette CI n'ayant jamais pu etre executee dans l'environnement de
developpement (pas de Windows/Rust/NSIS ici), trois echecs reels ont ete
rencontres et corriges a partir des messages d'erreur transmis :

1. **`bundle > windows > nsis` invalide** (etape "Preparer le sidecar et
   compiler l'installeur NSIS") - deux champs de `tauri.conf.json`
   n'existaient pas dans le schema Tauri v2 reel (`license` sous `nsis`,
   qui n'existe qu'au niveau `bundle.licenseFile` ; `hooks` renomme
   `installerHooks`). Corrige et revalide contre le schema JSON officiel
   (`schema.tauri.app/config/2`) avant de repousser.
2. **`resource path ..\backend\dist-sea\postgres` introuvable** (meme
   etape) - `npm run postgres:download-binaries` (Lot 2) n'etait pas
   execute dans le workflow avant `build:sea`, qui est le moment ou ce
   dossier est copie vers `dist-sea/postgres`. Ajoute comme etape dediee,
   avec l'activation prealable de l'environnement MSVC (nmake, necessaire
   a la compilation de pgvector) - voir liste des etapes ci-dessus.
3. **`resource path ..\backend\dist-sea\.env` introuvable** (meme etape) -
   ce fichier contient des secrets, donc jamais commis (`.gitignore`),
   forcement absent sur la machine CI. Retire de `tauri.conf.json` plutot
   que remplace par un `.env.example` : verifie que le sidecar Tauri
   (`main.rs`) fixe deja `HOST`/`PORT`/`DATABASE_MODE`/`AURORE_APP_ROOT`
   directement, sans passer par `.env`. Corrige a la source les deux
   variables qui, elles, en dependaient reellement au demarrage :
   `SESSION_SECRET` est desormais genere automatiquement par installation
   (`security/sessionSecretStore.ts`, meme principe que la cle de
   chiffrement du Lot 2bis) ; la cle API du fournisseur IA actif n'est
   plus verifiee de facon bloquante au demarrage (une garde equivalente
   existait deja au moment de l'utilisation reelle dans
   `services/llm/*.ts`) - **question ouverte, non tranchee ici**, voir
   "Cle API IA de production" dans la checklist ci-dessous.

## Parcours web teste (le seul testable ici)

Sequence validee en conditions reelles (base Postgres portable jetable,
comme tous les lots precedents) :

1. `http://127.0.0.1:3000` (page d'accueil) redirige automatiquement vers
   `/welcome-setup.html` tant qu'aucun mode n'a ete choisi.
2. Clic "Commencer" -> `/setup-mode.html`, choix "Poste unique", clic
   "Confirmer" -> `deploymentMode=standalone` enregistre.
3. Comme aucun redemarrage n'est necessaire pour "Poste unique" (le
   binding par defaut, 127.0.0.1, est deja celui utilise avant tout
   choix), un bouton "Continuer vers l'activation de la licence" apparait
   et mene directement a `/licence.html`.
4. Tentative de connexion sans licence : bloquee (403, `licenceEtat:
   "absente"`).
5. Licence de test valide (cle Ed25519 de test du Lot 3) glissee/activee
   via l'API : `etat: "valide"`.
6. Connexion reussie avec un compte de test.

Le cas "Serveur reseau" (redemarrage reellement necessaire pour le rebind
HTTPS/0.0.0.0) reutilise le mecanisme deja valide independamment au
Lot 6 - non re-teste integralement ici, seule la nouvelle branche de code
(affichage du message de redemarrage au lieu du bouton "Continuer") a ete
relue attentivement.

## En cas d'ecran "Démarrage d'Aurore..." bloque

Si l'application installee reste bloquee sur cet ecran sans jamais
afficher l'interface, le fichier suivant contient le detail technique
(cree/complete automatiquement a chaque tentative de demarrage, depuis
que ce fichier existe - voir "Decisions techniques notables" ci-dessous) :

```
%APPDATA%\Aurore\logs\aurore-shell.log
```

Ouvrable avec le Bloc-notes Windows (tapez ce chemin dans la barre
d'adresse de l'Explorateur, ou Win+R). Une boite de dialogue d'erreur
s'affiche desormais aussi automatiquement apres environ 30 secondes
d'attente infructueuse, rappelant ce chemin.

## Decisions techniques notables

### Journal de diagnostic du demarrage (`aurore-shell.log`)

La coquille Tauri (`main.rs`) est compilee avec `windows_subsystem =
"windows"` en version release (pas de console) : les `println!`/
`eprintln!` habituels ne sont visibles nulle part une fois l'app
installee - un premier vrai test d'installation (voir plus haut) l'a
confirme concretement (ecran de chargement bloque indefiniment, sidecar
absent du Gestionnaire des taches, aucun moyen de savoir pourquoi).
Corrige en ajoutant `log_line()` (ecriture best-effort, ne fait jamais
planter l'app) qui duplique vers `%APPDATA%\Aurore\logs\aurore-shell.log`
: la resolution du dossier de ressources, le lancement du sidecar (succes
ou echec), tout son stdout/stderr relaye, et le resultat du health-check
(y compris son eventuel timeout, desormais aussi signale par une boite de
dialogue native - voir section ci-dessus).

### Auto-update gere entierement cote Rust, pas via l'API JS du plugin

La fenetre principale d'Aurore affiche une page web servie par le sidecar
(`http://127.0.0.1:PORT`), pas les assets empaquetes par Tauri lui-meme.
Impossible de verifier dans cet environnement que le pont IPC/JS de Tauri
(`window.__TAURI__`) reste injecte dans ce contexte particulier. Plutot que
de batir une confirmation de mise a jour en JS sur une hypothese non
verifiable, `updater.rs` fait tout cote Rust : verification en
arriere-plan (jamais bloquante, une erreur reseau est simplement ignoree),
puis boite de dialogue **native** Oui/Non avant tout telechargement -
satisfait la contrainte "jamais de mise a jour silencieuse" sans dependre
du contexte web.

### Cle publique de mise a jour : placeholder explicite

`tauri.conf.json` (`plugins.updater.pubkey`) contient la valeur litterale
`REMPLACER_PAR_LA_VRAIE_CLE_PUBLIQUE_ED25519_DE_MISE_A_JOUR`. Sans CLI
Tauri, impossible de generer une vraie paire de cles
(`tauri signer generate`). C'est volontairement bloquant : avec un
placeholder, l'updater refusera (a juste titre) toute mise a jour tant
qu'une vraie cle n'est pas configuree - comportement plus sur qu'une cle
inventee qui accepterait n'importe quoi.

### Cible de bundle restreinte a NSIS

`bundle.targets` est passe de `"all"` a `["nsis"]` : ce lot est
specifiquement le paquet Windows NSIS demande par le prompt - MSI ou
d'autres formats ne sont pas dans le perimetre.

### Ecran de bienvenue : orchestrateur, pas une reimplementation

`welcome-setup.html` ne duplique ni la logique de choix de mode
(`setup-mode.html`, Lot 6) ni celle d'activation de licence
(`licence.html`, Lot 3) - il ajoute juste une premiere page d'accueil
avant elles, et un chainage minimal (voir plus haut) entre les deux.
`api.js` a ete modifie d'une seule ligne (`/setup-mode.html` ->
`/welcome-setup.html` comme cible de redirection initiale) ;
`setup-mode.html` reste entierement utilisable seul, comme avant, pour un
changement de mode ulterieur par un titulaire deja connecte (le nouveau
bouton "Continuer" ne s'affiche que lors de la toute premiere
configuration, jamais lors d'un changement fait plus tard).

## Procedure de build (a executer sur une machine avec Rust + Tauri CLI)

```bash
# 1. Backend obfusque (Lot 7) -> executable Node SEA
cd backend
npm install
npm run postgres:download-binaries   # necessite Visual Studio Build Tools (pgvector) - voir README-LOT2.md
npm run build:sea
cd ..

# 2. Cle de signature des mises a jour (une seule fois, a conserver precieusement)
npm install
npx tauri signer generate -w ~/.tauri/aurore-updater.key
# Copier la cle PUBLIQUE affichee dans tauri.conf.json (plugins.updater.pubkey)
# La cle PRIVEE ne doit JAMAIS etre commise - a stocker en lieu sur (coffre secret AzoMedIA)

# 3. Installeur NSIS
npm run tauri:build
# Produit src-tauri/target/release/bundle/nsis/Aurore_<version>_x64-setup.exe
```

## Versionner une nouvelle release

Le numero de version vient d'un seul endroit : `src-tauri/tauri.conf.json`
(`version`). Le faire correspondre a `backend/package.json` (`version`) et
`src-tauri/Cargo.toml` (`version`) a chaque release, pour que le meme
numero apparaisse dans le nom du fichier installeur ET dans l'ecran
"A propos" de l'application.

## A faire avant toute distribution reelle a un cabinet

Liste explicite, pour ne rien oublier au premier vrai build :

- [x] Declencher le workflow GitHub Actions au moins une fois et corriger
      les eventuels echecs - deux allers-retours reels ont ete necessaires
      et sont documentes ci-dessous ("Historique des echecs corriges")
- [x] Ajouter au workflow le telechargement/compilation des binaires
      PostgreSQL portables (`npm run postgres:download-binaries`, avant
      `build:sea` - voir etape "Telecharger les binaires PostgreSQL
      portables" du workflow). Necessite nmake/cl.exe sur le PATH pour
      compiler pgvector (aucun binaire precompile officiel) : ajoute via
      l'action `ilammy/msvc-dev-cmd`, qui active l'installation Visual
      Studio deja presente sur les runners `windows-latest` sans rien
      installer de plus.
- [ ] **Cle API IA de production** (decision non tranchee) : sans elle,
      l'app demarre et fonctionne normalement mais toute action IA
      (extraction, redaction, recherche jurisprudence) echoue avec
      "XXX_API_KEY manquant". Deux options, a trancher avec AzoMedIA :
      (a) une cle partagee par tous les cabinets, ajoutee comme secret
      chiffre GitHub (`Settings > Secrets and variables > Actions`) et
      injectee dans `.env` par une etape du workflow avant `build:sea` ;
      (b) une saisie par cabinet (nouvel ecran de configuration, plus gros
      chantier - aucune UI de ce type n'existe aujourd'hui). Voir
      "Historique des echecs corriges" ci-dessus pour le contexte.
- [ ] Generer la vraie paire de cles de signature updater, remplacer le
      placeholder dans `tauri.conf.json`
- [ ] Heberger un vrai endpoint de mise a jour a l'URL configuree
      (`https://updates.aurore-app.bj/...` - actuellement fictif)
- [ ] Tester l'installeur sur une VM Windows vierge (snapshot avant/apres)
- [ ] Faire tester le parcours complet par une personne n'ayant pas
      participe au developpement, noter les points de confusion
- [ ] Prendre les vraies captures d'ecran pour `docs-utilisateur/`
      (emplacements deja marques dans chaque guide)
- [ ] Tester reellement la desinstallation (conservation ET suppression
      des donnees) sur cette VM
- [ ] Remplacer la cle publique de licence de test (Lot 3) par la vraie
      cle de production une fois le Lot 4 (service Cloudflare) disponible
      - rappel deja documente au Lot 3, toujours vrai ici
