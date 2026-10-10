# Lot 10 (Aurore Mobile) — Protocole de synchronisation et d'appairage

À relire avant le Prompt 2 : c'est la pièce qui fait ou défait la promesse de confidentialité ("aucun service cloud, jamais de perte, l'avocat décide").

## Décisions actées avec l'utilisateur (avant ce document)

- Code mobile dans **ce même dépôt** (pas de dépôt séparé).
- Journal d'audit mobile : **table dédiée** (`MobileAuditLog`), pas d'extension d'`AuditLog`.
- Un scan "courrier" peut devenir **soit** un `DocumentDossier` (GED du dossier), **soit** une pièce jointe du courrier — choix fait par l'avocat à l'écran (Prompt 2/5), les deux chemins doivent exister côté serveur.
- **Pas de module payant "mobile"** : la fonctionnalité dépend uniquement de la licence du cabinet (déjà vérifiée par `requireLicence` sur tout `/api/*`) et d'un réglage cabinet simple (`Cabinet.mobileSyncActif`), pas d'une clé dans `MODULES_DISPONIBLES`. Conséquence directe et voulue : licence suspendue/expirée ⇒ plus de synchronisation mobile, exactement comme le reste de l'app.
- Pare-feu Windows : **Option B retenue** — Aurore tente d'ouvrir lui-même le port mobile (élévation UAC) au moment de l'activation du réglage, plutôt qu'un script manuel. Voir section 6.

## 1. Écart volontaire par rapport au plan initial : X25519 natif plutôt que tweetnacl

Le plan proposait `tweetnacl` (box/secretbox). Après vérification (`node --version` → v24.18.1, `crypto.generateKeyPairSync("x25519", ...)` fonctionne nativement), je retiens **le module `crypto` natif de Node** à la place, pour trois raisons :
1. Zéro dépendance tierce supplémentaire (convention déjà affichée ailleurs dans ce projet — `utils/creneauHebdomadaire.ts` évite délibérément une bibliothèque de fuseaux horaires pour la même raison).
2. Le reste du projet chiffre déjà tout en **AES-256-GCM** (`security/encryptionAtRest.ts`, `services/stockageDocuments.ts`) — rester sur cet algorithme pour le transport mobile évite d'introduire un **deuxième** algorithme de chiffrement (XSalsa20-Poly1305 de NaCl) à auditer/maintenir en parallèle.
3. `crypto.diffieHellman()` (ECDH X25519) + HKDF-SHA256 pour dériver la clé AES est un remplacement direct et éprouvé de `nacl.box`, sans perte de garantie de sécurité pour ce cas d'usage (réseau local, pas de certificat à épingler).

Toute application mobile (React Native) devra utiliser une bibliothèque équivalente côté Android (`react-native-quick-crypto`, ou le module natif `expo-crypto`/`@noble/curves` pour X25519 — **à trancher au Prompt 3**, hors périmètre de ce document qui ne couvre que le côté serveur).

## 2. Clé permanente du cabinet

- À la **première activation** du réglage "Synchronisation mobile" (`PATCH /api/mobile/reglages`), le serveur génère **une seule fois** une paire de clés X25519 permanente pour le cabinet : `Cabinet.mobileServerClePublique` (base64, en clair — c'est une clé **publique**) et `Cabinet.mobileServerClePrivee` (chiffrée au repos via le mécanisme existant `security/prismaEncryption.ts`, même principe que les tokens OAuth2 de `ConnexionCalendrierExterne`).
- Cette paire ne change jamais tant que le titulaire ne la régénère pas explicitement (action destructrice : invalide tous les appareils déjà appairés, nécessite donc une confirmation explicite type `confirmerSuppression`).

## 3. Appairage (QR → confirmation PC)

### 3.1 Génération du QR (PC, authentifié, `POST /api/mobile/appareils/qr`)

1. L'utilisateur connecté (titulaire, avocat ou collaborateur) demande un QR **pour lui-même** — un appareil est toujours lié au compte qui a généré le QR, jamais choisi par le téléphone.
2. Le serveur génère un secret aléatoire de 32 octets (`secret`), calcule `secretHash = sha256(secret)`, et crée une ligne `MobilePairingSecret` : `{ id, cabinetId, userId, secretHash, expireAt: now+5min, utilise: false }`.
3. Réponse JSON (le rendu visuel du QR lui-même — image — est à la charge de l'écran, Prompt 2) :
   ```json
   {
     "pairingId": "<id de MobilePairingSecret>",
     "secret": "<32 octets, base64 — UNIQUEMENT dans cette réponse, jamais stocké en clair>",
     "clePubliquePC": "<Cabinet.mobileServerClePublique>",
     "adresses": ["192.168.x.x:3100", ...],
     "expireAt": "2026-..."
   }
   ```
   `adresses` provient de la même détection d'interfaces réseau que `routes/networkInfo.ts` (déjà utilisée pour afficher l'IP du serveur en mode réseau), filtrée sur l'interface choisie dans le réglage mobile (`Cabinet.mobileSyncInterface`) si renseignée, sinon toutes les interfaces locales non-loopback.
4. Le secret n'est **jamais** stocké en clair côté serveur (seul `secretHash`), et n'existe en clair côté PC que le temps de cette unique réponse HTTP (consommée immédiatement par l'écran pour composer le QR).

### 3.2 Demande d'appairage (téléphone → PC, `POST /api/m/appairage/demander`, NON authentifiée)

**Seule route non authentifiée de tout `/api/m/*`** (cohérent avec le plan : "toutes authentifiées sauf la demande d'appairage").

Requête :
```json
{ "pairingId": "...", "secret": "<base64>", "clePubliqueTelephone": "<base64>", "nomAppareil": "Pixel 7 de Maître X" }
```

Traitement serveur :
1. Charge `MobilePairingSecret` par `pairingId`. 404 si absent.
2. Rejette si `expireAt < now` ou `utilise === true` → `410 Gone`, journalisé dans `MobileAuditLog` (`etape: "appairage_expire"` ou `"appairage_deja_utilise"`).
3. Compare `sha256(secret) === secretHash` (comparaison en temps constant, `crypto.timingSafeEqual`). Échec → `401`, journalisé (`"appairage_secret_invalide"`), **et** limite de débit dédiée très stricte par IP (voir section 5) pour rendre un brute-force sur le secret (32 octets, donc déjà infaisable en 5 minutes, mais défense en profondeur).
4. Succès : marque `utilise = true`, crée `MobileDevice` : `{ cabinetId, userId (celui du pairingSecret), nomDeclare, clePublique: clePubliqueTelephone, statut: "en_attente" }`. Journalise (`"appairage_demande"`, succès).
5. Réponse : `{ "deviceId": "...", "statut": "en_attente" }`.

### 3.3 Confirmation (PC, authentifié, `PATCH /api/mobile/appareils/:id/autoriser`)

- Réservé au titulaire, **ou** à l'utilisateur propriétaire du device (`device.userId === req.auth.userId`).
- Passe `MobileDevice.statut` à `"autorise"`, `autoriseAt = now`. Journalise (`"appairage_autorise"`).
- **Aucun jeton à transmettre au téléphone à cet instant** — voir section 4, l'authentification des requêtes suivantes ne repose pas sur un jeton porteur mais sur la clé partagée ECDH, déjà calculable des deux côtés depuis l'étape 3.2. Le téléphone apprend que l'appairage est accepté en interrogeant `POST /api/m/appairage/statut/:deviceId` (voir 3.4).
- Refus symétrique : `PATCH /api/mobile/appareils/:id/refuser` → `statut: "revoque"` directement (jamais autorisé), journalise (`"appairage_refuse"`).

### 3.4 Attente côté téléphone (`POST /api/m/appairage/statut/:deviceId`, authentifiée par chiffrement — voir section 4, mais acceptée même si `statut !== "autorise"` pour permettre ce polling)

Réponse : `{ "statut": "en_attente" | "autorise" | "revoque" }`. Le téléphone poll cette route toutes les ~3 secondes après avoir envoyé sa demande (Prompt 3), affiche "En attente de confirmation sur l'ordinateur" tant que `en_attente`.

## 4. Authentification des requêtes après appairage — clé partagée, pas de jeton porteur

**Écart volontaire par rapport à la lettre du plan** ("porte le jeton propre à l'appareil") : plutôt qu'un jeton à générer côté PC puis à faire parvenir au téléphone après la confirmation (ce qui pose un problème non trivial — par quel canal le transmettre sans repasser par un QR ou une saisie manuelle ?), j'utilise la propriété mathématique de l'échange Diffie-Hellman : **les deux parties peuvent calculer indépendamment le même secret partagé, sans jamais le transmettre**, dès lors qu'elles connaissent la clé publique de l'autre — ce qui est déjà le cas dès l'étape 3.2 (le serveur a `clePubliqueTelephone`, le téléphone a `clePubliquePC` depuis le QR).

- **Clé partagée** : `SK = HKDF-SHA256(ECDH(clePriveePC, clePubliqueTelephone), salt="aurore-mobile-v1", info=deviceId, longueur=32)`. Recalculable à tout instant côté serveur (il n'a jamais besoin de la stocker), et côté téléphone (calculée une fois après l'appairage, stockée dans son coffre matériel — Prompt 3).
- **Le "jeton propre à l'appareil"** mentionné par le plan devient alors simplement `deviceId` : il n'authentifie rien par lui-même, il indique juste **quelle** clé publique utiliser pour la vérification. L'authentification réelle est la capacité à produire un message dont le tag d'authentification AES-GCM est valide pour `SK` — ce que seul le téléphone qui a fait l'échange ECDH peut faire.
- **Enveloppe de chaque requête** `/api/m/*` (sauf `appairage/demander`) :
  ```json
  {
    "deviceId": "...",
    "compteur": 42,
    "horodatage": 1760000000000,
    "enveloppe": "<base64 : nonce(12 octets) || ciphertext || authTag(16 octets)>"
  }
  ```
  `nonce`, `compteur` et `horodatage` sont inclus en AAD (données authentifiées additionnelles) de l'AES-GCM — falsifier l'un d'eux invalide le tag.
- **Anti-rejeu** : le serveur garde `MobileDevice.dernierCompteur` (dernière valeur acceptée). Une requête avec `compteur <= dernierCompteur` est rejetée (`409`), tout comme un `horodatage` décalé de plus de 5 minutes par rapport à l'horloge serveur (cas limite "horloge du téléphone décalée" du plan, prévu comme message d'erreur explicite côté app mobile, Prompt 6).
- **Révocation immédiate** : `PATCH /api/mobile/appareils/:id/revoquer` passe `statut: "revoque"`. Toute requête chiffrée suivante de ce `deviceId` est déchiffrée avec succès (la clé ne change pas) mais **rejetée au niveau applicatif** (`403`) tant que `statut !== "autorise"` — vérifié avant tout traitement métier, à chaque requête, jamais mis en cache.
- **Écart d'implémentation (mineur)** : `POST /api/m/ping`, `POST /api/m/appairage/statut/:deviceId` et `POST /api/m/dossiers` sont en **POST**, jamais en GET, bien que purement consultatifs — une enveloppe chiffrée obligatoire doit voyager dans un corps JSON ; un GET-avec-corps n'est pas fiable (certains clients/proxys l'ignorent silencieusement).

## 5. Limitation de débit et blocage

- Nouveau limiteur dédié (`middleware/rateLimit.ts`) : `mobileApiLimiter`, par IP, plus strict que `globalApiLimiter` (code applicatif, pas la peine de répéter ici — voir implémentation).
- `POST /api/m/appairage/demander` : limiteur **encore plus strict** et dédié (peu de volume légitime attendu : un cabinet appaire quelques téléphones, rarement).
- Pas de blocage permanent par IP (un cabinet entier derrière une seule IP NAT ne doit jamais se retrouver bloqué collectivement) — fenêtre glissante uniquement, comme le reste de l'app.

## 6. Serveur mobile isolé et pare-feu (Option B)

- **Deuxième instance Express**, distincte de `app` (`backend/src/app.ts`), montant **uniquement** le routeur mobile (préfixe `/api/m/*` — voir note ci-dessous sur le choix du préfixe). Désactivée par défaut (`Cabinet.mobileSyncActif = false`).
- **Écart volontaire sur le préfixe** : le plan suggérait `/m/*` (hors `/api`). Je retiens **`/api/m/*`** à la place, pour une raison concrète : `middleware/requireLicence.ts` et `middleware/rateLimit.ts` (`globalApiLimiter`) ne s'appliquent aujourd'hui qu'aux chemins commençant par `/api` — en restant sous ce préfixe, le serveur mobile hérite gratuitement de la dépendance à la licence déjà décidée (section "Décisions actées") sans dupliquer cette logique dans une deuxième instance Express. Le serveur mobile est néanmoins une instance Express **séparée** (objectif A du plan respecté à la lettre) : seul le préfixe de route change, pas l'isolation réseau.
- Écoute sur l'interface choisie (`Cabinet.mobileSyncInterface`, jamais `0.0.0.0` par défaut) et le port choisi (`Cabinet.mobileSyncPort`, défaut 3100 — distinct de 3000/3001 déjà utilisés par le serveur principal/la fenêtre Tauri).
- **Pare-feu (Option B choisie par l'utilisateur)** : à l'activation du réglage, le backend tente d'exécuter une commande PowerShell élevée (`Start-Process powershell -Verb RunAs -ArgumentList '-File', '<chemin>\installer\firewall-rule.ps1', '-Port', '3100', '-Force'`) — ce qui déclenche l'invite UAC Windows standard. Si l'utilisateur refuse l'élévation, ou si la commande échoue, le réglage reste activé côté base de données mais un message clair est renvoyé : *"Le port n'a pas pu être ouvert automatiquement sur le pare-feu. Lance `installer\\firewall-rule.ps1 -Port 3100` toi-même, en administrateur."* — jamais d'échec silencieux. **Je ne peux pas tester moi-même l'invite UAC réelle** (pas de session Windows interactive dans cet environnement) : à vérifier par l'utilisateur à l'activation du réglage.
- `firewall-rule.ps1` existant est réutilisé **sans modification** (déjà paramétrable par `-Port`), cohérent avec la contrainte "petit pas".

## 7. Ce que ce document NE couvre PAS (périmètre des prompts suivants)

- Rendu visuel du QR (image) : Prompt 2 (écran).
- Stockage/vault côté téléphone, calcul ECDH côté React Native : Prompt 3.
- Logique d'enregistrement audio, repères, scan : Prompts 4/5.
- File d'envoi et reprise de téléversement par morceaux côté téléphone : Prompt 6 (le présent document décrit déjà le format serveur de `POST /api/m/items` + chunks + commit, implémenté au Prompt 1, mais la logique de reprise/retry est côté téléphone).

---
*Rédigé par Claude Code avant implémentation (branche `lot10-01-sync-serveur`), conformément à la consigne du Prompt 1.*
