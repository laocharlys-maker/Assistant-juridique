# Lot 7 — Obfuscation, durcissement sécurité, tests de bout en bout

Ce document décrit ce qui a été mis en place pour ce lot, les résultats
mesurés (audit, temps de démarrage), les trois bugs non triviaux rencontrés
en construisant le pipeline complet, et — point le plus important pour le
discours commercial d'AzoMedIA — les **limites réelles** de la protection
anti-copie. Aucun fichier de logique métier (`webActions.ts`, `webForms.ts`,
`documentExport.ts`, `documentFormalisme.ts`, `services/llm/`) n'a été
modifié par ce lot.

## 1. Ce qui a été livré

- `obfuscator.config.js` — configuration `javascript-obfuscator` calibrée.
- `scripts/build-sea.js` — obfusque le code Aurore **avant** le bundling
  esbuild, puis empaquette normalement (Node SEA).
- `scripts/security-audit.js` — `npm audit` + détection de `console.*`
  logant potentiellement une donnée sensible.
- `tests/e2e/` — 3 suites (`full-workflow`, `licence-expiry-flow`,
  `network-mode`), 20 tests, sur base PostgreSQL jetable.
- `vitest.config.ts` — délais adaptés aux tests d'intégration (E/S réelles).

## 2. Obfuscation : architecture retenue

**Le code n'est PAS obfusqué après le bundling esbuild.** Il est obfusqué
**fichier par fichier, avant** le bundling, sur le code compilé propre à
Aurore uniquement (`dist/`, ~90 fichiers, ~612 Ko) — jamais sur les
dépendances npm vendues dans le bundle final (SDK Anthropic/Gemini, `docx`,
`mammoth`, etc., ~17 Mo). Ce choix n'était pas la première tentative : voir
§4 pour pourquoi obfusquer le bundle complet a échoué deux fois de suite.

Séquence dans `build-sea.js` :
1. `prepareWorkDir()` copie `dist/` vers `dist-sea-obf-src/` et applique les
   mêmes shims que l'ancienne étape esbuild (`__dirname`, `require()` de
   `@prisma/client`/`pdfkit`).
2. `discoverModuleSpecifiers()` scanne tous les fichiers pour la liste
   exacte des chaînes passées à `require(...)`/`import(...)` (140 trouvées
   dans ce projet) et les protège explicitement de l'obfuscation.
3. `obfuscateWorkDir()` obfusque chaque fichier individuellement avec
   `obfuscator.config.js` + les 140 chaînes protégées.
4. Le bundling esbuild puis l'empaquetage SEA se déroulent normalement sur
   le résultat obfusqué.

Une copie lisible (shimmée mais non obfusquée) et les source maps par
fichier sont conservées dans `dist-sea-debug/` (`.gitignore`, jamais livrée
à un cabinet) pour pouvoir déboguer un crash à partir de sa stack trace.

`AURORE_SKIP_OBFUSCATION=1 npm run build:sea` permet de reconstruire sans
obfuscation (confort de développement — **jamais** pour un binaire livré).

## 3. Configuration retenue et pourquoi

| Option | Valeur | Raison |
|---|---|---|
| `controlFlowFlattening` | `false` | Provoquait un crash mémoire (voir §4.1) même à seuil réduit ; le gain de protection ne justifiait pas le risque de casser le build. |
| `stringArray` + rotation/mélange/base64 | activé | Protection principale : toutes les chaînes littérales (messages, noms de champs, la clé publique de licence...) sont déplacées dans un tableau encodé et indirectement référencées. |
| `renameGlobals` | `true` | **Contre-intuitif** : avec l'obfuscation fichier par fichier, chaque déclaration de premier niveau (`const licenceManager_1 = require(...)`) est vue comme "globale" par l'obfuscateur isolé à ce fichier. Avec `renameGlobals: false` (choix initial, en apparence plus prudent), ces noms restaient en clair. Vérifié sûr : aucune référence croisée entre fichiers ne dépend de ces noms (uniquement `require()`/`module.exports`, jamais partagés directement). |
| `transformObjectKeys` | `false` | Volontairement désactivé : casserait les noms de champs Prisma (`where`, `data`, ...) et la forme des réponses JSON de l'API. Conséquence assumée : les clés d'objet restent lisibles (voir §5). |
| `reservedStrings` | chemins relatifs + les 140 spécificateurs `require`/`import` réels du projet | Empêche l'obfuscation de casser la résolution des imports dynamiques dans le binaire SEA (voir §4.2/4.3). |
| `selfDefending`, `debugProtection`, `deadCodeInjection` | `false` | Alourdissent fortement la taille et le temps de démarrage pour un gain de protection marginal face à un attaquant qui a de toute façon accès au binaire complet. |
| `sourceMap` | `true` (séparé, non livré) | Pour pouvoir déboguer un crash de production sans exposer le mapping au client. |

## 4. Trois bugs réels rencontrés (et corrigés) en testant le build complet

Conformément à la consigne de ce lot, l'obfuscation a été testée à chaque
étape **dans le pipeline complet** (`npm run build:sea` de bout en bout,
jamais l'obfuscation isolée) — ce qui a permis de trouver trois problèmes
qu'un test isolé n'aurait pas révélés.

### 4.1 — Obfuscer le bundle complet fait planter Node (out of memory)

Première tentative : obfusquer `bundle.cjs` généré (17,6 Mo, toutes les
dépendances npm incluses) après le bundling. `controlFlowFlattening` faisait
planter le process ("JavaScript heap out of memory") après plus de 200
secondes. Même désactivé, `stringArray` seul plantait encore (SIGABRT, sur
~17 Mo de code). **Correction** : ne jamais obfusquer les dépendances
vendues — seulement le code propre à Aurore (~0,6 Mo), avant bundling
(voir §2).

### 4.2 — `stringArray` casse les imports dynamiques dans le binaire SEA

Une fois l'obfuscation déplacée avant le bundling, `import("./config/env")`
se retrouvait avec sa chaîne cachée derrière une fonction obfusquée
(`import(_0x29209b(0x169))`). esbuild ne peut alors plus résoudre l'import
statiquement et le laisse tel quel dans le bundle — ce qui, dans un
exécutable SEA, provoque `ERR_UNKNOWN_BUILTIN_MODULE` au runtime (le
`require`/`import` embarqué de Node SEA ne résout que ce qu'il peut tracer
statiquement). **Correction initiale** : `reservedStrings: ["^\\.\\.?/"]`
(chemins relatifs jamais déplacés dans le tableau de chaînes).

### 4.3 — Le même bug réapparaît, de façon non déterministe, sur un spécificateur non relatif

`stringArrayThreshold: 0.75` est **probabiliste** (pas de seed fixe) : sur
une reconstruction ultérieure, `require("dotenv/config")` (spécificateur nu,
non couvert par le motif "chemin relatif") s'est retrouvé caché à son tour,
avec la même erreur `ERR_UNKNOWN_BUILTIN_MODULE`. Un motif regex, aussi
prudent soit-il, ne peut pas couvrir par construction tous les cas réels.
**Correction robuste** : `discoverModuleSpecifiers()` extrait par analyse du
code source la liste **exacte** de tous les `require()`/`import()` réels du
projet et les protège un par un (correspondance exacte, pas un motif
deviné) — garantie déterministe plutôt que probabiliste.

## 5. Ce que l'obfuscation protège réellement (vérifié empiriquement)

- Les noms de variables/fonctions internes (`licenceManager_1`,
  `empreinteMachine` en tant qu'identifiant de code) sont bien renommés en
  identifiants hexadécimaux — vérifié par recherche du texte en clair dans
  `dist-sea/bundle.cjs` obfusqué vs non-obfusqué.
- La clé publique Ed25519 de vérification de licence (constante PEM en dur
  dans le code source) **n'apparaît nulle part en clair** dans le binaire
  obfusqué — vérifié en cherchant son contenu base64 exact
  (`MCowBQYDK2VwAyEA...`) : absent. Elle est déplacée dans le tableau de
  chaînes encodé, comme tout littéral de chaîne.
- Aucune clé API LLM n'est codée en dur dans le code source (recherche de
  motifs `AIzaSy...`/`sk-ant-...` : rien trouvé) — elle n'existe que dans le
  fichier `.env` local du poste (jamais commité, jamais empaqueté dans le
  binaire), lu au démarrage via `process.env`.

## 6. Ce que l'obfuscation NE protège PAS — à dire honnêtement au client

Ce point est le plus important de ce document pour éviter toute promesse
commerciale excessive.

- **Les clés d'objet (noms de champs) restent lisibles en clair** :
  `transformObjectKeys` est désactivé (nécessaire pour ne pas casser Prisma
  ni la forme des réponses API). Des chaînes comme `"empreinteMachine"`,
  `"motDePasseHash"` ou `"licenceManager"` sont donc visibles dans le
  binaire — comme clé d'un objet JSON/Zod, jamais comme code exécutable
  manipulable. Un attaquant peut ainsi apprendre les **noms** des champs et
  modules du projet, pas leur logique interne.
- **Les noms de fichiers/modules restent devinables.** Les spécificateurs
  `require()`/`import()` sont volontairement laissés en clair (§4.3), donc
  les noms des fonctions internes générées par esbuild à partir de ces
  chemins (ex. `require_licenceManager_js`) le restent aussi. Cela révèle
  l'existence et le nom d'un fichier comme `security/licenceManager.ts`,
  jamais son contenu (qui, lui, est bien obfusqué).
- **Les noms de variables d'environnement restent en clair** (`GEMINI_API_KEY`,
  `SESSION_SECRET`...) : accédées via `process.env.NOM` (notation pointée,
  jamais une chaîne littérale), elles ne passent jamais par `stringArray`.
  Ce n'est pas une fuite de secret — seul le **nom** de la variable est
  visible, jamais sa **valeur**, qui n'est de toute façon jamais dans le
  binaire (lue depuis `.env` à l'exécution).
- **L'obfuscation JavaScript n'est PAS un chiffrement.** Un attaquant motivé,
  disposant d'outils d'analyse statique/dynamique (débogueur Node, hooks
  runtime, désobfuscateurs génériques disponibles publiquement) peut, avec
  du temps, reconstituer une bonne partie du fonctionnement du code. Ce lot
  relève significativement la barre contre la copie/lecture **occasionnelle**
  (un utilisateur curieux qui ouvre `bundle.cjs` dans un éditeur) ; il ne
  rend pas le code **incopiable** face à un reverse engineer déterminé.
- **La vraie protection anti-copie du produit n'est pas l'obfuscation** :
  c'est l'empreinte machine (Lot 3, `security/machineFingerprint.ts`) liée
  à un fichier de licence signé (Ed25519, clé privée jamais présente dans le
  binaire) que le middleware `requireLicence` vérifie à chaque requête.
  L'obfuscation ralentit la compréhension du code, mais l'exécutable ne
  fonctionne de toute façon pas sans une licence valide pour la machine sur
  laquelle il tourne. **C'est ce mécanisme, pas l'obfuscation, qu'il faut
  mettre en avant dans le discours commercial.**

**Formulation recommandée pour AzoMedIA** : "Le code est obfusqué pour
décourager la copie et la rétro-ingénierie occasionnelles ; la protection
contre une réutilisation non autorisée repose avant tout sur le
verrouillage par licence et empreinte machine." — jamais "code impossible à
copier" ou "sécurité inviolable".

## 7. Résultats mesurés

### 7.1 Build complet

`npm run build:sea` (obfuscation incluse) : ~60 s de bout en bout, dont
**7,4 s** pour l'étape d'obfuscation elle-même (90 fichiers, 612 Ko → 760 Ko
de code source obfusqué). Le binaire produit répond correctement au
health-check.

### 7.2 Temps de démarrage (jusqu'à `/health` → 200 OK, base de test réelle)

| Build | 1er lancement (binaire fraîchement écrit) | Lancements suivants (à chaud) |
|---|---|---|
| Obfusqué | ~12,4 s | ~1,85 s (1845/1875/1861 ms sur 3 mesures) |
| Non obfusqué (`AURORE_SKIP_OBFUSCATION=1`) | ~8,1 s | ~1,35 s (1395/1345 ms sur 2 mesures) |

Le premier lancement, nettement plus lent, est constaté **sur les deux
builds** (obfusqué et non-obfusqué) dans des proportions comparables : il
s'agit très probablement de l'analyse antivirus Windows (Defender) d'un
exécutable PE qu'il voit pour la première fois, pas d'un effet de
l'obfuscation. Une fois "chaud", le démarrage obfusqué reste sous le seuil
de 5 s fixé pour ce lot, avec un surcoût d'environ 0,5 s par rapport au
build non obfusqué (renommage d'identifiants + décodage du tableau de
chaînes à chaque démarrage).

### 7.3 Audit de sécurité (`npm run security-audit`)

Dernière exécution (2026-08-02) :

- `npm audit` : 5 vulnérabilités connues (3 moyennes, 1 haute, 1 critique),
  toutes situées dans des **dépendances de développement uniquement**
  (`esbuild` — serveur de dev, `vite`/`vite-node`/`vitest`/`@vitest/mocker`)
  — aucune dans les dépendances de production listées dans `package.json`.
  Aucune de ces failles n'affecte le binaire livré (elles ne sont jamais
  empaquetées). Le script a été validé pour détecter effectivement une
  vulnérabilité : installation temporaire de `minimist@0.0.8` (connu
  vulnérable) → détection confirmée (comptage 5 → 6, paquet listé) puis
  retrait confirmé.
- Recherche de `console.*` sensible : **0 occurrence suspecte** sur 83
  fichiers source analysés. Le script a été validé positivement : un fichier
  de test temporaire contenant `console.log("password:", password)` et
  `` console.log(`token=${token}`) `` a bien été détecté (fichier:ligne,
  identifiant, mot-clé), puis le script ne détecte plus rien une fois ce
  fichier supprimé. Les messages légitimes du type
  `console.log("[licence] statut evalue...")` ne sont pas signalés (le
  script ne réagit qu'à un identifiant de code réellement journalisé, pas au
  texte d'un message).

Le statut "ÉCHEC" actuel de `security-audit` reflète uniquement les 5
vulnérabilités de tooling de développement ci-dessus (jugées acceptables
tout au long de ce projet) — pas un problème sur le code livré.

## 8. Tests de bout en bout

`npm run test:e2e` — 3 fichiers, 20 tests, ~30 s au total. Se saute
automatiquement (avec message clair) si aucun PostgreSQL n'est trouvé sur la
machine.

- **`full-workflow.test.ts`** (10 tests) : démarrage → licence bloque l'accès
  API tant qu'inactive → activation d'une licence de test signée (clé Ed25519
  de test, Lot 3) → session/login → création d'un client fictif → **vérifie
  le chiffrement au repos** (Lot 2bis : `nom`/`telephone` illisibles en SQL
  brut, préfixe `enc:v1:`) → génération d'un acte avec **pseudonymisation**
  (Lot 5 : le LLM, mocké, ne reçoit jamais le vrai nom du destinataire, reçoit
  `PARTIE_A` à la place ; le document final, lui, contient bien le vrai nom)
  → contenu de l'acte chiffré en base → export Word (signature ZIP `PK`) →
  export PDF (signature `%PDF`).
- **`licence-expiry-flow.test.ts`** (4 tests) : les trois états de licence du
  Lot 3 (valide → grâce → bloquée) via de vrais appels HTTP à
  `/api/licence/activate`, puis vérification que la ré-activation lève
  immédiatement le blocage.
- **`network-mode.test.ts`** (6 tests) : mode réseau du Lot 6 — serveur en
  HTTPS sur toutes les interfaces, certificat couvrant `aurore.local` et
  l'IP LAN réelle de la machine (un "second poste" est simulé en
  interrogeant cette IP plutôt que `127.0.0.1`), authentification toujours
  requise, HTTP simple refusé sur le même port.

Toutes les suites tournent sur un cluster PostgreSQL **jetable** (créé/détruit
à chaque run via `initdb`/`pg_ctl`, jamais une base contenant de vraies
données), avec un `%APPDATA%` isolé (répertoire temporaire, jamais le vrai
profil utilisateur), et un jeu de données explicitement fictif ("Cabinet
Test", "Client Fictif"). Le LLM est systématiquement mocké — aucun appel
réel/facturé pendant les tests.

**Playwright** : non utilisé pour ce lot. Les tests d'intégration au niveau
API (vraies requêtes HTTP contre un vrai serveur Express + vraie base
Postgres, sans mock de la couche HTTP) couvrent déjà l'intégralité des
scénarios demandés (licence, pseudonymisation, chiffrement, export, mode
réseau) de bout en bout côté serveur. Un test de parcours réel dans la
webview Tauri apporterait une couverture supplémentaire sur le rendu
front-end, mais n'était pas nécessaire pour valider le fonctionnement
combiné des Lots 1 à 6 tel que demandé par ce lot — à reconsidérer si des
régressions purement UI (rendu, interactions DOM) devaient un jour être
couvertes.

## 9. Comment reproduire

```
npm run build:sea          # build complet, obfuscation incluse
npm run security-audit     # audit npm + scan console.*
npm run test:e2e           # 20 tests, ~30s (nécessite un PostgreSQL local)
```
