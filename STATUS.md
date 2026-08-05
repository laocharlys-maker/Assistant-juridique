# État des lieux — Aurore

Dernière mise à jour : 2026-08-03. Ce fichier est un instantané pour reprendre le travail dans une nouvelle session — il n'est pas maintenu en continu, vérifier `git log`/`git status` pour l'état le plus frais si ce fichier a plus de quelques jours.

## 1. Avancement général

### Fusionné dans `claude/aurore-solution-improvement-rqcjqt` (branche principale)

Tous testés et validés manuellement avec l'utilisateur, à leur époque :

| Lot | Contenu | Commit de fusion |
|---|---|---|
| 1 | Packaging Tauri sidecar + Node SEA | `7358b89` |
| 2 | PostgreSQL portable + installation/désinstallation propre | `ef361e5` |
| 2bis | Chiffrement au repos (AES-256-GCM) | `e74007e` |
| 3 | Système de licence locale (Ed25519 + empreinte machine) | `aa22864` |
| 5 | Pseudonymisation avant appel LLM | `50b7db4` |
| 6 | Mode serveur réseau (multi-poste) | `0941a04` |
| 7 | Obfuscation, durcissement sécurité, tests e2e | `b69757c` |

### ⏳ Lot 4 — code écrit et testé en local, déploiement en attente d'accès Cloudflare

**Service Cloudflare Workers de vérification de licence en ligne** ("phone-home"). Le Lot 3 a été construit pour l'appeler (`LICENCE_PHONE_HOME_URL` dans `.env.example`, mode "auto" vs "manuel" dans `licenceManager.ts`).

Dépôt séparé `aurore-licence-service` (`c:\Users\HP\Documents\aurore-licence-service`, hors de ce dépôt — côté AzoMedIA, pas côté cabinet), commit initial `731d1ac` : Cloudflare Workers (Hono) + D1, signature Ed25519 via Web Crypto natif, dashboard admin (créer un cabinet, générer/révoquer une licence), route `/phone-home` publique rate-limitée. Testé réellement en local (`wrangler dev` + D1 local réel) : génération de licence, révocation propagée au phone-home suivant, rejet propre d'un payload avec un champ métier injecté, auth admin bloquant tout accès sans identifiants. **Interopérabilité vérifiée avec le vrai code du dépôt principal** : une licence signée par le Worker a été vérifiée avec succès par `verifyLicenceSignature()` (`licenceManager.ts`, Lot 3) sans aucune modification.

**Reste bloqué sur des identifiants que je n'ai pas** : `wrangler deploy` vers un vrai compte Cloudflare (créer le compte/la base D1 distante, poser les secrets `PRIVATE_KEY_PEM`/`ADMIN_USERNAME`/`ADMIN_PASSWORD`), puis générer la vraie paire de clés Ed25519 de production (`node scripts/generate-keypair.js`) et coller la clé publique dans `backend/src/config/licencePublicKey.ts` à la place du placeholder de test. Procédure complète dans `aurore-licence-service/README.md`.

### En cours : `lot8-installeur-final` (pas encore fusionné)

Installeur Windows NSIS final + documentation utilisateur + auto-update + compilation automatisée via GitHub Actions. Branche poussée sur GitHub, à jour avec le distant (19 commits, dernier : `72ea609`).

**Les 5 livrables du prompt initial sont écrits et poussés :**
- Config bundle NSIS dans `tauri.conf.json`
- Écran de bienvenue post-installation (bienvenue → choix du mode → activation licence)
- Désinstalleur avec choix explicite conserver/supprimer les données
- Auto-update avec confirmation native obligatoire (`updater.rs`, tout en Rust)
- Documentation utilisateur (`docs-utilisateur/`, 5 guides sans jargon)

**Plus, ajouté en cours de route (voir section 3 pour le détail) :**
- Workflow GitHub Actions (`.github/workflows/build-windows-installer.yml`) qui compile l'installeur automatiquement sur `windows-latest`, sans rien à installer côté utilisateur
- Écran "À propos" avec numéro de version
- Journal de diagnostic (`%APPDATA%\Aurore\logs\aurore-shell.log`) pour les futurs échecs de démarrage
- Une dizaine de bugs réels trouvés et corrigés au premier vrai passage en compilation/installation (voir section 3)

**Statut au moment de la rédaction** : un installeur produit par CI (commit `72ea609`) a été testé pour de vrai sur une machine Windows — démarrage complet réussi (Postgres portable + pgvector + backend + `/health` qui répond). C'est la première fois que le parcours complet fonctionne de bout en bout. **Pas encore testé : l'application Tauri complète (fenêtre + sidecar via le vrai mécanisme Tauri, pas le lancement manuel en ligne de commande utilisé pour diagnostiquer) — à confirmer par l'utilisateur.**

### Reste à faire avant de fusionner `lot8-installeur-final`

- [ ] Confirmation utilisateur que l'app installée démarre normalement (double-clic, pas la ligne de commande) et affiche l'interface
- [ ] Test du parcours de désinstallation (conservation ET suppression des données) sur une vraie installation
- [ ] Voir aussi la liste "À faire avant toute distribution réelle" dans `README-LOT8.md` (clé updater, endpoint updater réel, VM vierge, vraies captures d'écran, clé de licence de production...)
- [ ] Une fois validé par l'utilisateur : fusionner dans `claude/aurore-solution-improvement-rqcjqt` (même procédure que les lots précédents : `git merge --no-ff`)

## 2. Bug le plus récent : "postgres.exe manquant" — RÉSOLU (pas un vrai bug)

Signalé par l'utilisateur comme blocage ("le programme postgres est necessaire pour initdb... n'a pas ete trouve"). Investigation menée jusqu'au bout dans cette même session :

- Téléchargement direct du dernier installeur produit par CI (`gh run download`) et inspection du dossier `bin/` réellement installé sur la machine de l'utilisateur (qui est aussi cette machine de développement, même profil Windows `C:\Users\HP\...`) : **`postgres.exe` est bien présent**, complet (8,6 Mo), avec les 73 autres fichiers attendus.
- Reproduction directe du test de l'utilisateur (mêmes variables d'environnement, même binaire) : **succès complet** — `initdb`, activation pgvector, création du schéma, démarrage Postgres, `/health` répond `{"status":"ok","database":"connected"}`.
- **Conclusion** : ce n'est pas un bug de packaging. Hypothèse la plus probable : verrou temporaire de Windows Defender sur le fichier `postgres.exe` fraîchement écrit par l'installeur (comportement Windows connu quand un `.exe` volumineux est scanné juste après extraction), si l'utilisateur a relancé l'app immédiatement après l'installation.
- **Pas de correction de code nécessaire, pas de nouveau passage CI nécessaire.**
- **En attente** : confirmation de l'utilisateur qu'un simple redémarrage de l'app (double-clic, sans rien changer) fonctionne. Si l'erreur revient à l'identique, creuser du côté d'une exclusion Windows Defender pour le dossier d'installation.

## 3. Bugs déjà rencontrés et corrigés pendant le Lot 8 (pour ne pas les re-découvrir)

Tout le code Rust/Tauri/NSIS de ce projet n'avait **jamais été compilé ni installé pour de vrai** avant ce lot (aucun Rust/NSIS disponible dans l'environnement de développement) — chaque bug ci-dessous est donc un vrai bug jamais détecté avant, découvert un par un au fil des vrais passages en CI puis en installation réelle.

1. **`bundle.windows.nsis` invalide dans `tauri.conf.json`** — `license` n'existe pas à ce niveau (seulement `bundle.licenseFile`) ; `hooks` a été renommé `installerHooks` dans le schéma Tauri v2. *(commit `6af94ab`)*
2. **`postgres:download-binaries` jamais exécuté dans le workflow CI** avant `build:sea` → `dist-sea/postgres` jamais créé. Ajouté comme étape dédiée + activation de l'environnement MSVC (`ilammy/msvc-dev-cmd`) nécessaire pour compiler pgvector. *(commit `af6fb1c`)*
3. **`.env` référencé comme ressource Tauri mais jamais commis** (contient des secrets) → absent sur la machine CI. Retiré des ressources ; `SESSION_SECRET` est désormais généré automatiquement par installation (`security/sessionSecretStore.ts`, même principe que la clé de chiffrement du Lot 2bis) ; la validation stricte de la clé API IA au démarrage a été retirée (redondante avec la garde déjà présente au moment de l'usage réel dans `services/llm/*.ts`). *(commit `05d8ef5`)*
4. **`32x32.png` et `128x128.png` étaient en réalité le même fichier 256×256** (hash identique), mal nommés. Corrigé par re-génération aux bonnes tailles. *(commit `9f21f10`)*
5. **`serde_json` absent de `Cargo.toml`** — la macro `tauri::generate_context!()` en a besoin comme dépendance directe (piège connu de Tauri v2), jamais ajoutée faute de commande `#[tauri::command]` dans ce projet minimal. *(commit `0b42749`)*
6. **Aucun moyen de diagnostiquer un échec de démarrage une fois installé** — `windows_subsystem = "windows"` supprime toute console en version release, donc tous les `println!`/`eprintln!` étaient invisibles. Ajout d'un vrai journal fichier (`%APPDATA%\Aurore\logs\aurore-shell.log`) + boîte de dialogue native en cas d'échec du health-check. *(commit `61dfb6a`)*
7. **Fichiers SQL de pgvector jamais copiés** — `vector.control` vit à la racine du dépôt pgvector, mais **tous** les scripts SQL (dont `vector--0.8.0.sql`, généré par la compilation elle-même) vivent dans le sous-dossier `sql/`, jamais à la racine. La boucle de copie ne lisait que la racine → l'extension s'installait avec une version déclarée mais sans aucun script pour l'installer (`extension "vector" has no installation script...`). Corrigé + vérification explicite post-copie. Documenté aussi dans `README-LOT2.md`. *(commit `72ea609`)*
8. **Chemin `AURORE_APP_ROOT` corrompu lors d'un test manuel** (`Auroreaurore-backend.exe` collé) — investigation a confirmé qu'il ne s'agissait **pas** d'un bug de code (tous les usages de `path.join()` sont corrects, vérifiés un par un), mais très probablement d'une erreur de saisie dans l'invite de commande (deux lignes collées sans passage à la ligne). Pas de correction de code ; instructions de test ré-écrites avec une étape de vérification (`echo %AURORE_APP_ROOT%`).
9. **Pollution de `%APPDATA%\Aurore` par les propres tests de développement** (PostgreSQL 17 utilisé en local vs. PostgreSQL 16 dans le vrai build) — sans lien avec le code, mais a semé la confusion sur cette machine partagée entre environnement de dev et poste de test réel de l'utilisateur. Nettoyé à plusieurs reprises ; à garder en tête si une nouvelle confusion apparaît (`%APPDATA%\Aurore` peut contenir des restes d'un test précédent, toujours regarder les dates de génération avant de conclure).

## 4. Points en suspens, à trancher plus tard (pas urgents, pas bloquants pour le Lot 8)

- **Clé API IA de production** : sans elle, l'app démarre et fonctionne normalement, mais toute action IA (extraction, rédaction, recherche jurisprudence) échoue avec un message clair ("XXX_API_KEY manquant"). Deux options possibles, à trancher avec AzoMedIA :
  - (a) une clé partagée par tous les cabinets, ajoutée comme secret chiffré GitHub Actions et injectée dans `.env` au moment du build ;
  - (b) une saisie par cabinet (nouvel écran de configuration — n'existe pas aujourd'hui, chantier plus gros).
  Détaillé dans `README-LOT8.md`.
- **Clé publique de mise à jour (updater)** : `tauri.conf.json` contient un placeholder littéral (`REMPLACER_PAR_LA_VRAIE_CLE_PUBLIQUE_ED25519_DE_MISE_A_JOUR`). Nécessite `tauri signer generate` (CLI Tauri, indisponible dans cet environnement) — à faire sur une machine avec le CLI avant toute distribution réelle.
- **Endpoint de mise à jour réel** (`https://updates.aurore-app.bj/...`) : actuellement fictif, rien n'est hébergé à cette adresse.
- **Clé publique de licence de test (Lot 3)** : à remplacer par la vraie clé de production une fois le Lot 4 déployé (génération de la clé bloquée sur le déploiement Cloudflare, voir section 1).
- **Lot 4 lui-même** (voir section 1) : code écrit et testé en local, déploiement bloqué sur des identifiants Cloudflare que je n'ai pas.

## Pour reprendre le travail

- Branche courante : `lot8-installeur-final`, à jour avec `origin/lot8-installeur-final`.
- Pour tester un nouveau build : déclencher le workflow "Build installeur Windows Aurore" depuis l'onglet Actions de GitHub (voir `README-LOT8.md` pour la procédure pas-à-pas sans ligne de commande).
- En cas d'échec CI ou d'échec au démarrage de l'app installée : consulter `%APPDATA%\Aurore\logs\aurore-shell.log` en premier (nouveau depuis le commit `61dfb6a`), sinon suivre la méthode de lancement manuel documentée plus haut dans cette conversation (raccourci → emplacement du fichier → `cmd` dans la barre d'adresse → variables d'environnement → lancer `aurore-backend.exe`).
