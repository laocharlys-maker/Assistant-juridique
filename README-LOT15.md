# Lot 15 : stockage documentaire par dossier (GED)

Stockage et retrouvaille, au même endroit qu'un dossier, de toutes les
pièces reçues (contrats scannés, correspondances, preuves, pièces
d'identité) — indépendamment de tout acte généré par Aurore
(`Action.contenuGenere`, inchangé). Ne touche à aucune logique métier
existante : `webForms.ts`, `webActions.ts`, `documentExport.ts`,
`documentFormalisme.ts` et le schéma `Action` ne sont pas modifiés
(vérifié — confirmé aussi par la suite de tests complète rejouée sans
régression, y compris `full-workflow.test.ts` qui couvre bout en bout la
génération/export d'un acte).

## Emplacement de stockage

`{userDataDir()}/documents/{dossierId}/{uuid}.enc` — `userDataDir()` est
la fonction **déjà existante** (`database/portablePaths.ts`, Lot 2/2bis)
qui résout `%APPDATA%/Aurore` sous Windows (équivalents macOS/Linux),
**réutilisée telle quelle**, jamais dupliquée : c'est le même dossier
racine que le data directory Postgres portable et la clé de chiffrement
applicative — **jamais** le dossier d'installation de l'app, qui peut être
en lecture seule ou écrasé à la mise à jour (contrainte explicite du
prompt).

**Mode réseau (Lot 6)** : ce chemin est résolu sur la machine qui exécute
le process Express — en mode réseau, c'est le **serveur**. Les postes
clients ne lisent jamais ce dossier directement ; ils passent uniquement
par les routes HTTP (`routes/documentsDossier.ts`), qui lisent/déchiffrent
le fichier côté serveur avant de le renvoyer dans la réponse — aucune
logique de stockage distribué n'était donc nécessaire, l'architecture
existante (sidecar Express partagé) suffit par construction.

## Stratégie de chiffrement

Réutilise la **même clé applicative** que `security/encryptionAtRest.ts`
(Lot 2bis) via `loadOrCreateEncryptionKey()`, **importée telle quelle** —
aucune nouvelle clé, aucun nouveau mécanisme. Différence assumée et
documentée : `encryptField()`/`decryptField()` du Lot 2bis opèrent sur des
**chaînes UTF-8** (conçues pour des champs texte en base) — inadaptées à
un fichier binaire arbitraire (un PDF, une image ou un `.docx` n'est pas
du texte UTF-8 valide ; les convertir via `.toString("utf8")` corromprait
le contenu). `services/stockageDocuments.ts` définit donc deux fonctions
locales (`chiffrerBuffer`/`dechiffrerBuffer`) qui appliquent **exactement
le même algorithme** (AES-256-GCM, IV 12 octets, tag d'authentification 16
octets) à des `Buffer` plutôt qu'à des chaînes, et écrivent le résultat en
binaire brut sur disque (`IV || AuthTag || ciphertext`) plutôt qu'en
base64 (inutile pour un fichier, ~33% d'espace disque économisé par
rapport à une réutilisation littérale du format texte du Lot 2bis).

Nom de fichier sur disque : **UUID** (`crypto.randomUUID()` + `.enc`),
jamais le nom d'origine — qui reste uniquement en métadonnée
(`DocumentDossier.nomOriginal`) pour l'affichage. Évite collisions et toute
fuite d'information via le nom de fichier (contrainte du prompt).

## Transport : réutilisation du pattern existant, pas de `multer`

Vérifié avant d'ajouter une dépendance (demande explicite du prompt) :
`multer` n'était pas présent, et **le projet a déjà un pattern d'upload
sans lui** — `routes/signature.ts` et `routes/cabinet.ts` (en-tête du
cabinet) acceptent déjà un fichier sous forme de **Data URL base64** dans
le corps JSON (`FileReader.readAsDataURL()` côté navigateur). Ce lot suit
**le même pattern**, plutôt que d'introduire `multer` et un nouveau
paradigme `multipart/form-data` qui n'existe nulle part ailleurs dans la
base de code — cohérence retenue plutôt qu'une nouvelle dépendance.

Conséquence : la limite globale `express.json()` (`app.ts`) est passée de
15 Mo à 30 Mo pour absorber le surcoût d'encodage base64 (~33%) d'une
pièce jointe — la limite **métier** réelle par fichier reste
`DOCUMENTS_TAILLE_MAX_MO` (20 Mo par défaut, **configurable**), vérifiée
explicitement côté route sur le contenu **décodé** ; le plafond JSON n'est
qu'un garde-fou de transport avec de la marge, jamais la limite affichée à
l'utilisateur.

## Types acceptés / taille maximale

Allowlist stricte (`TYPES_AUTORISES`, `routes/documentsDossier.ts`) :
`application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`,
`application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
(.docx), `text/plain` — tout le reste (exécutables, archives...) est
rejeté (`415`) avec un message explicite. **Limite assumée** : la
vérification porte sur le type MIME annoncé par le navigateur (extrait du
Data URL), pas un sniffing de contenu binaire approfondi (signature de
fichier) — cohérent avec le niveau de rigueur des autres validations de
type déjà présentes dans le projet (ex. `signature.ts`), documenté ici
plutôt que silencieusement supposé robuste.

`DOCUMENTS_TAILLE_MAX_MO` (défaut 20) : dépassement rejeté avec `413` et
message clair indiquant la taille du fichier envoyé et la limite
autorisée.

## Permissions

**Aucun nouveau système de droits** : l'accès aux pièces d'un dossier suit
exactement la même règle que l'accès au dossier lui-même
(`GET /api/dossiers/:id`, `dossiers.ts`) — tout membre authentifié du
**même cabinet** peut consulter/uploader (vérifié : `dossier.cabinetId ===
req.auth.cabinetId`, sinon `404`, jamais `403` qui révélerait l'existence
du dossier à un cabinet tiers). La **suppression** est plus restreinte
(non exigée explicitement par le prompt au-delà de "mêmes règles que le
dossier", mais jugée raisonnable pour une action destructive) : réservée à
l'auteur de l'upload ou à un avocat/titulaire du cabinet.

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié - `DocumentDossier`, `emailOrigineId` nullable prévu pour le Lot 16 sans dépendance créée)
- `backend/prisma/migrations/20260808000000_documents_dossier/migration.sql` (nouveau)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/services/stockageDocuments.ts` (nouveau)
- `backend/src/routes/documentsDossier.ts` (nouveau)
- `backend/src/config/env.ts`, `.env.example` (modifiés - `DOCUMENTS_TAILLE_MAX_MO`)
- `backend/src/app.ts` (modifié - enregistrement du routeur, limite JSON 15mb → 30mb)
- `backend/public/dossier.html` (modifié - onglet "Pièces" : glisser-déposer, aperçu inline, téléchargement, suppression)
- `backend/public/style.css` (modifié - styles de la zone de dépôt)
- Tests : `src/services/__tests__/stockageDocuments.test.ts` (5 tests), `tests/e2e/documents-dossier.test.ts` (7 tests)
- `README-LOT15.md` (ce fichier)

**Non modifiés** (vérifié) : `webForms.ts`, `webActions.ts`,
`documentExport.ts`, `documentFormalisme.ts`, le schéma `Action`,
`security/encryptionAtRest.ts` (uniquement importé, jamais changé).

## Aperçu inline : jamais `window.open`/`target="_blank"`

Point d'attention découvert en relisant `js/api.js` : ce projet documente
explicitement que `target="_blank"` **n'a aucun effet dans la webview
desktop Tauri** (aucun gestionnaire côté Rust) — c'est pour cette raison
que les téléchargements existants utilisent déjà `fetch` + `Blob` +
`<a download>` plutôt qu'un lien classique. L'aperçu inline de ce lot suit
la **même prudence** : `fetch(...).blob()` + `URL.createObjectURL()` +
`<img>`/`<iframe>` insérés **directement dans la page** (jamais une
nouvelle fenêtre), pour PDF et images uniquement.

## Ce qui a été réellement testé

Suite complète du projet rejouée : **215/215 tests passés**, `tsc --noEmit`
propre, `eslint` sans nouvelle erreur (3 erreurs préexistantes, hors
fichiers de ce lot) — confirme aussi explicitement la **non-régression**
sur la génération/export d'actes (`full-workflow.test.ts`, inchangé,
toujours vert).

`stockageDocuments.test.ts` (5 tests, unitaire, vrai système de fichiers
dans un `%APPDATA%` temporaire isolé) : le fichier écrit sur disque ne
contient jamais le texte en clair (recherche directe de la chaîne
originale dans les octets bruts), nom de fichier UUID non prévisible,
déchiffrement bit-à-bit identique à l'original (y compris des octets
binaires arbitraires, pas seulement du texte), suppression idempotente
(tolérante si déjà absent), isolation correcte entre deux dossiers
différents.

`documents-dossier.test.ts` (7 tests, e2e, PostgreSQL + vrai système de
fichiers) : upload réel puis **lecture directe du fichier sur disque**
(hors app, via `fs.readFileSync`) confirmant l'absence de contenu en
clair ; liste correcte dans l'onglet "Pièces" ; téléchargement restituant
un contenu **bit-à-bit identique** à l'original ; rejet d'un type non
autorisé (`415`, message explicite) ; rejet d'un fichier dépassant la
taille configurée (`413`, message explicite, limite abaissée à 1 Mo pour
ce test précis afin de rester rapide) ; permissions (un utilisateur d'un
**autre cabinet** reçoit `404` sur la liste, le téléchargement et
l'upload) ; suppression retirant **à la fois** l'entrée en base et le
fichier physique (vérifié par `fs.existsSync` avant/après).

## Non testé dans cet environnement

- **Rendu visuel réel** du glisser-déposer et de l'aperçu inline (PDF dans
  un `<iframe>`, image dans un `<img>`) dans un navigateur - relu et
  syntaxiquement validé (`node --check`), pas cliqué/glissé.
- **Fichiers Word/PDF réels volumineux** (scan multi-pages proche de la
  limite de 20 Mo) - les tests utilisent des contenus courts/synthétiques
  suffisants pour valider le mécanisme, pas des documents réels.
