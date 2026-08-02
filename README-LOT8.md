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

Environ **15 a 25 minutes** pour un premier lancement (tout doit etre
telecharge/installe sur la machine temporaire de GitHub : Node.js, Rust,
le CLI Tauri, NSIS...). Les lancements suivants sont generalement plus
rapides (10 a 15 minutes), une partie des elements etant reutilisee d'une
fois sur l'autre.

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

## Decisions techniques notables

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

- [ ] Declencher le workflow GitHub Actions au moins une fois et corriger
      les eventuels echecs (voir ci-dessus - premiere execution reelle
      jamais faite au moment de la redaction de ce document)
- [ ] Ajouter au workflow le telechargement/compilation des binaires
      PostgreSQL portables (`npm run postgres:download-binaries`,
      necessite Visual Studio Build Tools pour pgvector - deja installes
      par defaut sur les machines `windows-latest` de GitHub, contrairement
      a cet environnement de developpement) : sans cette etape,
      l'installeur produit actuellement par le workflow n'a pas de base de
      donnees locale fonctionnelle (DATABASE_MODE=portable echouera)
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
