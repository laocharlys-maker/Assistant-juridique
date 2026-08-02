# Lot 3 : module Licence côté application

Vérification locale de licence, écrans d'activation/expiration, et
phone-home optionnel — la partie cliente uniquement. La génération des
licences (service Cloudflare Workers + D1) est le Lot 4, pas encore
développé : ce lot ne dépend que d'une clé publique Ed25519 et d'une URL
d'endpoint, toutes deux des placeholders de développement pour l'instant.

Aucune modification de `webForms.ts`, `webActions.ts`, `documentExport.ts`,
`documentFormalisme.ts`, `services/llm/` - vérifié via `git status` avant
livraison. Ce lot ajoute un module + un middleware + des routes + des
écrans frontend, plus une modification minimale et volontairement isolée de
`app.ts` (montage du routeur/middleware) et `index.ts` (planification du
phone-home), dans la même veine que ce que les Lots 2/2bis ont déjà fait
pour leurs propres besoins d'infrastructure.

## Format du fichier de licence (`.lic`)

```json
{
  "payload": {
    "cabinetId": "uuid",
    "nomCabinet": "string",
    "dateExpiration": "ISO-8601",
    "empreinteMachine": "sha256-hex",
    "modulesActifs": ["string"],
    "modeVerification": "auto" | "manuel"
  },
  "signature": "base64"
}
```

La signature porte sur une sérialisation JSON du payload à **ordre de clés
fixe** (`canonicalizePayload()` dans `licenceManager.ts`) - jamais l'ordre
d'insertion JS, pour que la signature soit reproductible quel que soit
l'outil qui a construit le payload côté signeur (voir script de génération
de licence de test ci-dessous).

## Choix techniques

### Vérification de signature : `node:crypto` natif (Ed25519)

Comme demandé, aucune dépendance tierce : `crypto.sign(null, message,
privateKey)` / `crypto.verify(null, message, publicKey, signature)`,
supporté nativement depuis Node 12. Testé avec ce Node (`v24.18.1`).

### Empreinte machine : lecture directe (pas de `node-machine-id`)

Le prompt proposait `node-machine-id` OU une lecture registre/WMIC
documentée si on préfère éviter la dépendance. Choix retenu : **lecture
directe**, dans la continuité de la philosophie déjà établie aux Lots 2/2bis
(éviter les dépendances tierces évitables - chiffrement au repos en
`node:crypto` natif, empreinte Postgres portable en binaires officiels
plutôt qu'un wrapper npm).

- **Windows** (plateforme principale d'Aurore desktop) : `Get-CimInstance
  Win32_ComputerSystemProduct | Select UUID` via PowerShell (testé, voir
  plus bas), avec repli sur `MachineGuid` du registre
  (`HKLM\SOFTWARE\Microsoft\Cryptography`) si PowerShell échoue.
- **Linux** (pertinent pour le Lot 6, serveur cabinet) : `/etc/machine-id`
  ou `/var/lib/dbus/machine-id`.
- **macOS** : `IOPlatformUUID` via `ioreg`.
- **Repli ultime** (aucune source lisible) : hash de
  `hostname+plateforme+architecture` - moins stable en théorie, mais évite
  un blocage total plutôt que de ne jamais pouvoir calculer d'empreinte.

L'identifiant brut n'est **jamais** stocké ni loggé : hashé en SHA-256
immédiatement, seul le hash (fichier `secrets/machine-fingerprint.json`,
même dossier protégé que les identifiants Postgres et la clé de chiffrement
des Lots 2/2bis) est conservé, mis en cache pour éviter de relancer
PowerShell à chaque requête.

**Limite connue de cet environnement de dev** : le repli registre (`reg
query`) n'a pas pu être testé directement dans le shell Git Bash utilisé ici
- MSYS2 réécrit automatiquement les arguments ressemblant à des chemins
Windows (`HKLM\SOFTWARE\...` perd ses antislashs avant d'atteindre
`reg.exe`), un artefact de cet environnement de développement, pas du code
livré (confirmé en désactivant cette réécriture via
`MSYS2_ARG_CONV_EXCL=*`, qui casse alors la résolution du chemin du script
lui-même - preuve que la réécriture était bien active). Le chemin
PowerShell principal, lui, a été testé pour de vrai et fonctionne
(`80FDD4A5-63FA-EB11-810C-508140C33007` obtenu sur la machine de dev).

### Période de grâce : 14 jours par défaut, configurable

`LICENCE_GRACE_JOURS` (10-15 recommandé par le prompt). En grâce, l'accès
API reste complet (voir plus bas) - seul un bandeau d'alerte s'affiche,
conformément à "accès réduit avec bandeau d'alerte" interprété comme
"toujours fonctionnel, juste signalé", pas une restriction fonctionnelle
supplémentaire (non spécifiée par le prompt).

### `licenceId` (champ Cabinet) : dérivé localement, pas dans le payload signé

La structure JSON du payload donnée par le prompt ne contient pas de champ
`licenceId`, alors que la migration Prisma en demande un sur `Cabinet`.
Interprétation retenue : `licenceId` est un identifiant court **dérivé
localement** (hash SHA-256 tronqué du payload canonique + de la signature,
`computeLicenceId()`), utile uniquement pour le support ("quelle licence
est installée sur ce poste ?"), jamais une donnée transmise par le service
de licence lui-même.

### `empreinteMachineAutorisee` mirroré en base : déjà un hash, jamais l'info brute

Cohérent avec la contrainte "ne jamais stocker l'info brute" - c'est
littéralement le même SHA-256 hex que celui comparé localement, jamais
l'UUID matériel.

### Synchronisation Cabinet : best-effort, jamais bloquante

`licenceManager.ts` reste utilisable sans base de données (fonctions pures
de vérification/évaluation testables isolément, voir plus bas) : la
synchronisation des 4 champs miroir sur `Cabinet` importe Prisma
**dynamiquement**, seulement au moment de l'appeler, et avale toute erreur
(cabinet pas encore créé, base injoignable...) avec un simple avertissement
journalisé - jamais une activation refusée à cause d'un problème DB
annexe. Vérifié empiriquement (voir tests) : l'activation réussit même
quand la table `cabinets` n'existe pas encore dans la base cible.

## Les trois états (+ absente)

| État | Déclencheur | Accès API | Frontend |
|---|---|---|---|
| `absente` | Aucun fichier `licence.lic` | Bloqué (403) sauf `/api/licence/*`, `/health` | Écran d'activation |
| `valide` | Avant `dateExpiration` | Normal | Rien de spécial |
| `grace` | Entre `dateExpiration` et `dateExpiration + LICENCE_GRACE_JOURS` | Normal | Bandeau d'alerte sur toutes les pages |
| `bloquee` | Grâce dépassée, OU empreinte machine différente, OU signature invalide, OU révocation reçue | Bloqué (403) sauf `/api/licence/*`, `/health` | Écran d'activation uniquement |

## Architecture

```
server/src/security/
  machineFingerprint.ts  - empreinte machine (I/O plateforme + cache disque)
  licenceManager.ts       - verification crypto (pure) + evaluation d'etat
                            (pure) + gestion fichier local + phone-home

server/src/config/
  licencePublicKey.ts     - cle publique Ed25519 (placeholder de test)

server/src/middleware/
  requireLicence.ts       - gate Express sur /api/* (sauf /api/licence/*, /health)

server/src/routes/
  licence.ts               - POST /api/licence/activate, GET .../status,
                              POST .../check-now

public/licence.html + public/js/licence.js  - ecran d'activation
public/js/layout.js (modifie)                - bandeau de grace sur toutes les pages
public/js/api.js (modifie)                   - redirige vers /licence.html
                                                (pas /login.html) si le
                                                blocage vient de la licence
```

`licenceManager.ts` est volontairement organisé en trois sections
clairement séparées (commentaires `====`) : vérification cryptographique
pure, évaluation d'état pure, gestion d'état locale avec effets de bord -
conformément à la bonne pratique demandée par le prompt.

### Pourquoi `app.ts`/`index.ts` sont touchés malgré la consigne "sans modifier le cœur métier"

Ni l'un ni l'autre ne contiennent de logique métier - `app.ts` ne fait que
déclarer l'ordre des routeurs Express, `index.ts` ne fait qu'orchestrer le
démarrage/les tâches planifiées (déjà modifié dans cet esprit aux Lots
1/2). Le middleware `requireLicence` doit être monté globalement pour
gater toutes les routes `/api/*` existantes sans les modifier une par une,
et le phone-home doit être planifié au même endroit que les autres tâches
`node-cron` du projet (veille, rétention, rôle de la semaine) pour rester
cohérent avec l'unique mécanisme de planification déjà en place.

## Phone-home (mode auto)

- **Démarrage** : `runPhoneHomeCheck()` appelée une fois, non bloquante
  (`.catch()`, jamais `await`é par le flux de démarrage principal).
- **Hebdomadaire** : `node-cron`, chaque dimanche 5h, fuseau
  `Africa/Porto-Novo` (même convention que les autres tâches du projet) -
  cadence calendaire fixe plutôt qu'un `setInterval` "tous les 7 jours à
  partir de maintenant", pour rester cohérent avec le seul mécanisme de
  planification déjà utilisé dans tout le projet.
- **Payload envoyé** : exactement `{ cabinetId, empreinteMachine,
  versionApp }` - rien d'autre, aucune donnée métier.
- **Mode manuel** : ces deux déclencheurs automatiques n'effectuent AUCUN
  appel réseau (`runPhoneHomeCheck()` sans `force` retourne immédiatement
  si `modeVerification !== "auto"`). Le bouton "Vérifier maintenant" appelle
  `runPhoneHomeCheck({ force: true })`, qui lui bypasse cette garde -
  c'est le seul cas où le mode manuel déclenche un appel réseau, et c'est
  toujours une action explicite de l'utilisateur.
- **Échec réseau** : jamais bloquant, jamais interprété comme une
  révocation - juste journalisé, nouvel essai au cycle suivant.
- **Renouvellement reçu** : la nouvelle licence est **re-vérifiée
  (signature) côté client avant d'être écrite sur disque** - jamais fait
  confiance aveuglément au serveur, même sur une connexion de confiance.
- **Révocation reçue** : jamais de coupure en cours de session - un simple
  marqueur (`secrets/licence-state.json`) est écrit, lu une seule fois par
  cycle de vie du process (mis en cache au premier appel de
  `getCurrentLicenceStatus()`), donc appliqué seulement au prochain
  redémarrage.

## `LICENCE_BYPASS` (développement uniquement)

`LICENCE_BYPASS=true` désactive le gate `requireLicence` - **mais
uniquement si `NODE_ENV !== "production"`**. Si activé par erreur avec
`NODE_ENV=production`, le middleware l'ignore explicitement et journalise
une erreur bruyante plutôt que d'accepter silencieusement. Vérifié
empiriquement (voir tests) dans les deux cas.

## Clés de test (`backend/test-keys/`)

**TEST UNIQUEMENT — NE PAS UTILISER EN PRODUCTION.** Paire Ed25519 générée
pour ce lot, sans aucun rapport avec la future clé de production du Lot 4.
La clé publique correspondante est déjà copiée dans
`server/src/config/licencePublicKey.ts` (à remplacer entièrement au Lot 4).

### Générer une licence de test manuellement

Script minimal (à exécuter avec `node`, aucune dépendance) :

```js
const crypto = require("crypto");
const fs = require("fs");

const priv = crypto.createPrivateKey({
  key: fs.readFileSync("backend/test-keys/licence-test-private.pem", "utf8"),
  format: "pem",
});

const payload = {
  cabinetId: "REMPLACER-PAR-UN-UUID-DE-CABINET-REEL",
  nomCabinet: "Cabinet Test",
  dateExpiration: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  // Recuperer la vraie empreinte via GET /api/licence/status apres une
  // premiere tentative d'activation (meme rejetee, elle est calculee et
  // mise en cache) ou en lisant directement
  // %APPDATA%/Aurore/secrets/machine-fingerprint.json sur le poste cible.
  empreinteMachine: "COLLER-ICI-LE-HASH-SHA256-64-CARACTERES",
  modulesActifs: ["all"],
  modeVerification: "manuel", // ou "auto"
};

// Ordre de cles IDENTIQUE a canonicalizePayload() dans licenceManager.ts -
// ne pas changer l'ordre, la signature ne correspondrait plus.
const ordered = {
  cabinetId: payload.cabinetId,
  nomCabinet: payload.nomCabinet,
  dateExpiration: payload.dateExpiration,
  empreinteMachine: payload.empreinteMachine,
  modulesActifs: payload.modulesActifs,
  modeVerification: payload.modeVerification,
};

const signature = crypto.sign(null, Buffer.from(JSON.stringify(ordered)), priv).toString("base64");
fs.writeFileSync("licence-test.lic", JSON.stringify({ payload, signature }, null, 2));
console.log("Ecrit : licence-test.lic");
```

Puis glisser-déposer `licence-test.lic` sur `/licence.html`, ou l'envoyer
directement :

```
curl -X POST http://127.0.0.1:3000/api/licence/activate \
  -H "Content-Type: application/json" \
  --data "{\"content\": $(node -e "console.log(JSON.stringify(require('fs').readFileSync('licence-test.lic','utf8')))")}"
```

## Ce qui a été réellement testé (et comment)

Contrairement au pgvector du Lot 2 et à la compilation Rust/Tauri des Lots
1/2, ce module ne dépend d'aucun toolchain externe et a pu être testé de
bout en bout **de deux façons complémentaires**, contre une vraie instance
PostgreSQL (même approche jetable que les lots précédents) :

**1. Script d'intégration direct** (import de `app.ts`, requêtes HTTP
réelles via `fetch` sur un serveur `app.listen(0)`) - créé pour cette
vérification, exécuté, puis **supprimé** (non commis, voir `git status`
avant livraison). Résultats observés réellement (11 scénarios, tous OK) :

```
=== 1) Etat initial : aucune licence ===
OK status absente
OK /health toujours accessible
OK /api/dossiers bloque (403, licenceEtat=absente)

=== 2) Activation avec une licence VALIDE ===
OK activation acceptee, etat=valide
OK /api/dossiers passe le gate licence (401 auth, pas 403 licence)

=== 3) Signature invalide (fichier modifie manuellement) ===
OK activation rejetee (signature invalide)

=== 4) Empreinte machine differente ===
OK activation rejetee (empreinte differente)
OK la licence valide precedente n'a pas ete ecrasee par les tentatives rejetees

=== 5) Expiration -> grace -> bloquee ===
OK etat grace, jours restants=9
OK en grace, /api/dossiers passe le gate licence (acces reduit = bandeau, pas blocage API)
OK etat bloquee (expiration > periode de grace)
OK /api/dossiers bloque en etat bloquee
OK /api/licence/status reste accessible meme licence bloquee

=== 6) Code colle en base64 (au lieu d'un fichier) ===
OK activation via code base64 acceptee

=== 7) Mode manuel : zero appel reseau automatique ===
OK mode manuel : runPhoneHomeCheck() sans force -> 0 appel reseau, action=ignore

=== 8) Mode manuel + force (bouton Verifier maintenant) : appel autorise ===
OK force:true declenche bien un appel, qui echoue proprement (echec-reseau) sans exception

=== 9) Mode auto : phone-home reseau coupe -> echec silencieux, app toujours vivante ===
OK phone-home auto echoue silencieusement, /health toujours 200 (app non bloquee)

=== 10) LICENCE_BYPASS=true hors production ===
OK LICENCE_BYPASS=true (hors prod) laisse passer le gate licence

=== 11) LICENCE_BYPASS=true EN PRODUCTION -> ignore ===
OK LICENCE_BYPASS force par erreur en production -> IGNORE, licence toujours appliquee
```

**2. Serveur réel démarré (`tsx src/index.ts`) + `curl` externe**, pour
vérifier le chemin HTTP complet indépendamment du script de test
lui-même : `/health` (200, DB reelle interrogee), `/licence.html`,
`/js/licence.js`, `/style.css` (200, servis normalement sans passer par le
gate licence), activation via une vraie requête `curl -X POST
/api/licence/activate` avec une licence signée par la clé de test et
l'empreinte machine réelle de la machine de développement, `/api/dossiers`
passant de 403 (licence) à 401 (auth) après activation, `/api/licence/status`
reflétant l'état à jour.

Couvre les critères d'acceptation du prompt : signature valide acceptée,
signature invalide rejetée, empreinte différente rejetée, grâce puis
blocage selon la date, middleware bloquant les routes métier tout en
laissant l'activation accessible, zéro appel réseau automatique en mode
manuel (vérifié en interceptant `global.fetch` et en comptant les appels,
équivalent programmatique de la capture réseau demandée), phone-home auto
tolérant à une coupure réseau.

## Non testé dans cet environnement

- **Interaction glisser-déposer réelle dans un navigateur** : la logique
  JS (`public/js/licence.js`) a été relue, vérifiée syntaxiquement
  (`node --check`) et exercée indirectement via les appels
  `/api/licence/activate` qu'elle déclenche (testés en réel, voir
  ci-dessus) - mais aucun outil de navigateur/automatisation UI n'est
  disponible dans cet environnement pour simuler un vrai `drag&drop` de
  fichier ou observer le rendu visuel du bandeau. A vérifier manuellement
  dans un navigateur avant mise en production.
- **Repli registre Windows (`reg query`)** de `machineFingerprint.ts` : le
  chemin PowerShell principal a été testé pour de vrai ; le repli n'a pas
  pu l'être dans ce shell (artefact MSYS2, voir plus haut) - le code suit
  le pattern standard Node `execFile` déjà utilisé ailleurs dans le projet.
- **Le futur service Cloudflare Workers (Lot 4)** lui-même, par définition
  hors de portée de ce lot.

## Fichiers livrés

- `server/src/security/licenceManager.ts` (nouveau)
- `server/src/security/machineFingerprint.ts` (nouveau)
- `server/src/middleware/requireLicence.ts` (nouveau)
- `server/src/routes/licence.ts` (nouveau)
- `server/src/config/licencePublicKey.ts` (nouveau)
- `server/prisma/schema.prisma` (modifié - 4 champs additifs sur `Cabinet`)
- `server/prisma/migrations/20260802010000_licence_cabinet_fields/migration.sql` (nouveau)
- `server/prisma/portable-init.sql` (regénéré)
- `server/src/app.ts` (modifié - montage routeur + middleware)
- `server/src/index.ts` (modifié - planification phone-home)
- `server/.env.example` (modifié - `LICENCE_PHONE_HOME_URL`, `LICENCE_GRACE_JOURS`, `LICENCE_BYPASS`)
- `public/licence.html`, `public/js/licence.js` (nouveaux)
- `public/js/layout.js` (modifié - bandeau de grâce)
- `public/js/api.js` (modifié - redirection vers `/licence.html` si blocage licence)
- `public/style.css` (modifié - styles bandeau/écran d'activation)
- `backend/test-keys/licence-test-private.pem`, `licence-test-public.pem` (nouveaux, TEST uniquement)
- `README-LOT3.md` (ce fichier)
