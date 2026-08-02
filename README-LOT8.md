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

En clair : tout le **code** demande par ce lot est ecrit, en suivant
precisement les conventions Tauri v2/NSIS connues. Ce qui necessite une
compilation reelle (le fichier `.exe` lui-meme) ne peut pas etre produit
ni teste ici. La premiere compilation reelle devra se faire sur une
machine avec Rust + Tauri CLI installes (voir "Procedure de build"
ci-dessous), suivie imperativement du test sur VM vierge demande par le
prompt de ce lot.

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

- [ ] Compiler sur une machine avec Rust + Tauri CLI installes
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
