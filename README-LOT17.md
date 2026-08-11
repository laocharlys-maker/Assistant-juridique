# Lot 17 : transcription de documents (OCR local) sur les pièces du dossier

Ajoute un module d'OCR (reconnaissance optique de caractères) qui extrait le
texte des pièces de dossier (`DocumentDossier`, Lot 15) lorsqu'il s'agit
d'une image (photo de contrat, pièce d'identité scannée) ou d'un PDF scanné
sans couche texte native — `pdf-parse` (déjà utilisé dans le projet) est
aveugle sur ce type de document. Ne touche à aucune logique métier
existante : `webActions.ts`, `documentExport.ts`, `documentFormalisme.ts` et
`stockageDocuments.ts` (Lot 15) ne sont pas modifiés au-delà de leur
réutilisation en dépendance (`lireFichier`).

## Aucun LLM sur le texte OCR — clause explicite

**Le texte OCR n'est jamais transmis à un LLM externe dans cette version.
Toute extension future impliquant une IA sur ce texte nécessite une
réévaluation de la confidentialité, le texte libre ne permettant pas la
tokenisation fiable utilisée au Lot 5.**

Décision de scope explicitement demandée : contrairement à
`Action.champsDocument` (Lot 5), qui permet une pseudonymisation fiable par
remplacement exact sur des champs structurés connus, un texte OCR est du
texte libre non structuré — aucune détection heuristique de noms fiable n'y
est possible, même raisonnement que la décision prise au Lot 16 sur le corps
des emails. Envoyer ce texte à un LLM sans garantie de pseudonymisation
exposerait potentiellement l'identité et les faits d'un dossier à un tiers.
Vérifié par un test dédié (`traitementOcr.test.ts`) qui grep les fichiers du
module et échoue si un import réel de `services/llm/` y apparaît.

## Tesseract local (tesseract.js) — jamais d'API cloud

Aucun appel à une API cloud (Google Vision, AWS Textract...) dans cette V1 :
une image ou un PDF potentiellement sensible (contrat, pièce d'identité
client) ne quitte jamais la machine du cabinet pour être reconnu. Une option
cloud opt-in par cabinet pourra être envisagée en V2, documentée comme un
choix assumé de dégradation de confidentialité contre un gain de précision —
hors scope ici.

**`tesseract.js` plutôt qu'un binaire `tesseract` en sous-processus** :
l'application est distribuée en exécutable portable (`scripts/build-sea.js`)
— une dépendance à un binaire système externe casserait ce mode de
distribution (chemin non garanti, installation séparée requise sur le poste
de l'utilisateur). `tesseract.js` embarque un moteur WASM autonome, sans
installation externe, au prix d'une vitesse de traitement inférieure au
binaire natif — assumé pour cette V1.

**Nuance sur le pack de langue française** : Tesseract a besoin d'un modèle
de langue (`fra.traineddata`, ~4 Mo) pour fonctionner. `tesseract.js` le
télécharge une seule fois depuis le CDN officiel du projet Tesseract
(`tessdata.projectnaptha.com`) lors de la toute première utilisation, puis le
met en cache localement (`userDataDir()/ocr-data`, voir
`services/ocr/moteurTesseract.ts`) pour tous les traitements suivants, y
compris hors-ligne. **Ce n'est pas un envoi de données du cabinet vers un
tiers** — aucune image ni aucun document n'est transmis, seul un fichier de
modèle générique est récupéré une fois. Un mode portable pourra pré-empaqueter
ce fichier en V2 pour un fonctionnement 100 % hors-ligne dès la première
utilisation (non fait ici, cohérent avec le choix de scope du prompt).

## PDF scannés : rasterisation via `pdf-to-png-converter`

`tesseract.js` reconnaît des images, pas des PDF directement. Chaque page
d'un PDF scanné est donc rasterisée en PNG avant OCR
(`services/ocr/moteurTesseract.ts`, fonction `rasteriserPdf`).

Choix de bibliothèque : `pdfjs-dist` (le moteur de rendu PDF sous-jacent) est
**ESM-only** depuis sa version 3 — incompatible tel quel avec ce projet
(`"module": "CommonJS"` dans `tsconfig.json`) sans un contournement fragile
de l'import dynamique. `pdf-to-png-converter` encapsule `pdfjs-dist` +
`@napi-rs/canvas` derrière une API **CommonJS** propre et fournit des
**binaires natifs précompilés** pour toutes les plateformes majeures (aucune
compilation locale requise, contrairement à `node-canvas`/Cairo) — évite à la
fois le problème ESM et le risque de build natif en environnement portable.

**Risque d'empaquetage — confirmé puis corrigé après diffusion.** Ce lot
ajoute pour la première fois une dépendance avec binaire natif compilé
(`@napi-rs/canvas`, via `pdf-to-png-converter`) et un moteur WASM exécuté
dans un thread séparé (`tesseract.js-core`, via `tesseract.js`) — jusqu'ici
toutes les dépendances (`docx`, `pdfkit`, `mammoth`...) étaient du JavaScript
pur. Le risque signalé ici s'est bien matérialisé en production dès le
premier essai réel : `scripts/build-sea.js` bundlait `tesseract.js`/
`pdf-to-png-converter` comme du JS pur via esbuild au lieu de les traiter
comme des paquets externes à copier avec leurs assets — au premier appel OCR
réel dans l'exécutable empaqueté, ce chargement cassait catastrophiquement
et emportait tout le process backend (symptôme côté utilisateur : "Failed to
fetch" puis blocage de l'app). Corrigé (voir le commit correspondant sur
`scripts/build-sea.js`) : les deux paquets sont maintenant dans
`EXTERNAL_PACKAGES_WITH_ASSETS`, avec une nouvelle fonction
`resolvePackageJsonClosure()` pour calculer leur fermeture de dépendances —
la sonde `require()` existante (`resolveRequireClosure`) ne convient pas ici,
`pdfjs-dist` étant chargé par un `import()` ESM dynamique et
`tesseract.js-core` dans un thread `worker_threads` séparé, tous deux
invisibles depuis `require.cache` du processus principal (vérifié
empiriquement). Validé en conditions réelles : build SEA complet local, puis
`require()` des deux paquets depuis `dist-sea/node_modules/` (pas l'original)
— rendu PDF→PNG et reconnaissance de texte réussis tous les deux.

## Seuil de détection "scanné vs texte natif"

`services/ocr/detectionScanne.ts`, constante `SEUIL_CARACTERES_PAR_PAGE = 40`
: un PDF dont `pdf-parse` extrait moins de 40 caractères par page est
considéré scanné (image sans couche texte exploitable) et routé vers l'OCR.
Un PDF avec du texte natif réel (conclusions, contrat tapé) en contient
généralement des centaines par page — 40 caractères/page laisse une marge
large pour ne jamais déclencher d'OCR inutile sur un PDF natif peu chargé en
texte sur une page donnée (page de garde, par exemple). Ajustable à un seul
endroit (aucune autre copie de ce seuil ailleurs dans le code).

Un PDF illisible par `pdf-parse` (corrompu, protégé par mot de passe) est
traité **comme nécessitant l'OCR par prudence**, plutôt que de bloquer le
traitement — Tesseract tentera sa propre lecture, et échouera proprement de
son côté (statut `echec`, message clair) si le fichier est réellement
illisible.

## Seuil d'avertissement "relecture manuelle recommandée"

`public/dossier.html`, constante `OCR_SEUIL_CONFIANCE_AVERTISSEMENT = 70` :
un score de confiance Tesseract (0-100, `Page.confidence`, moyenné par page
pour un PDF multi-pages) sous 70 % affiche un avertissement visuel explicite
dans la modale de détail. Volontairement côté frontend uniquement (pas de
seuil équivalent côté serveur) pour rester ajustable sans redéploiement
backend — le serveur renvoie toujours le score brut, jamais une évaluation
"fiable/pas fiable" pré-mâchée.

## Formats pris en charge en V1

**Couverts** : JPEG, PNG, PDF (image scannée sans texte natif).

**Non couverts, documentés explicitement** (`services/ocr/detectionScanne.ts`,
`TYPES_MIME_IMAGE_OCR`) : GIF, WEBP (acceptés à l'upload par le Lot 15 mais
hors périmètre OCR — aucun cas d'usage cabinet identifié, les scans arrivent
en pratique en PDF ou JPEG/PNG), Word (`.doc`/`.docx`), texte brut (déjà
exploitables tels quels), TIFF (non accepté à l'upload de toute façon). Une
tentative de relance manuelle sur un format non couvert renvoie une erreur
claire (`"Ce type de fichier n'est pas pris en charge par la reconnaissance
de texte (formats acceptés : JPEG, PNG, PDF)."`), jamais un échec silencieux.
Texte manuscrit : non couvert (limite de Tesseract lui-même, pas du ressort
de ce lot).

## Déclenchement : immédiat en tâche de fond, pas un cycle cron périodique

Choix différent du Lot 12b (synchro calendrier), documenté dans
`jobs/traitementOcr.ts` : l'OCR est déclenché **immédiatement** après un
upload réussi (`enqueuerTraitementOcr()`, appelée **sans `await`** depuis
`routes/documentsDossier.ts` — la réponse HTTP d'upload part avant la fin du
traitement), plutôt qu'une file consommée uniquement par un cycle cron
périodique.

**Justification du choix** (contrairement à la synchro calendrier, qui fait
des appels réseau vers un service tiers soumis à sa propre disponibilité et
à des limites de débit) : l'OCR est un traitement **100 % local**, sans
réseau ni limite de débit externe à ménager — le déclenchement immédiat donne
un badge de statut à jour en quelques secondes plutôt qu'une attente
potentielle de plusieurs minutes, sans aucun risque de surcharger un service
externe.

La table `OcrResultat` reste la source de vérité durable (comme
`EvenementSyncExterne` au Lot 12b) : un cycle cron de **rattrapage**
(`runOcrCycleDeSecours`, toutes les 5 minutes, `scheduleOcrQueue()` enregistré
dans `index.ts`) reprend tout traitement resté bloqué en
`en_attente`/`en_cours` au-delà de 10 minutes — cas d'un redémarrage serveur
survenu pendant un traitement.

Un échec de traitement (fichier corrompu, moteur indisponible) passe
immédiatement en statut `echec` avec un message clair — **jamais de relance
automatique en boucle** (contrairement au Lot 12b) : la relance est une
action explicite de l'utilisateur (`POST /api/documents/:id/ocr/relancer`).

## Chiffrement au repos

`OcrResultat.texteExtrait` est chiffré via `security/encryptionAtRest.ts`
(Lot 2bis) — **mêmes** `encryptField`/`decryptField`, même clé applicative,
même AES-256-GCM déjà retenu, aucun nouveau mécanisme. Déchiffré à la
demande uniquement (affichage de la modale, recherche plein texte) — jamais
stocké en clair, jamais loggué en clair (voir `jobs/traitementOcr.ts` : les
logs de déclenchement/issue portent le document, le statut, le score et la
durée, jamais le texte).

## Recherche plein texte sur contenu chiffré

Le texte étant chiffré au repos, une recherche ne peut pas être un simple
`LIKE` SQL sur la colonne chiffrée (`routes/ocr.ts`,
`GET /api/dossiers/:dossierId/documents/recherche-ocr`). Le volume de pièces
par dossier reste faible (quelques dizaines au plus, jamais un corpus
documentaire massif) : déchiffrement à la volée sur ce seul sous-ensemble
(les `OcrResultat` du dossier consulté, statut `termine`), jamais sur
l'ensemble de la table — pas d'indexation chiffrée dédiée, sur-ingénierie non
justifiée à ce volume.

## Permissions

Mêmes fonctions d'accès locales que `routes/documentsDossier.ts` (Lot 15),
dupliquées dans `routes/ocr.ts` (convention déjà établie dans ce projet —
chaque module de routes reste autonome) : tout membre du cabinet peut
consulter/relancer l'OCR d'une pièce de son cabinet, aucun système de droits
supplémentaire. Vérifié par un test e2e dédié (autre cabinet → 404 sur les
trois routes OCR).

## Copie vers la rédaction libre — point de départ éditable, jamais automatique

Le bouton "Copier vers un document en rédaction libre" (modale OCR,
`dossier.html`) stocke le texte dans `sessionStorage` puis redirige vers
`nouvelle-action.html`, qui ouvre directement l'écran "Rédiger librement"
avec une bannière d'information. La création du document reste **une action
explicite de l'utilisateur** : type de document, dossier/client et validation
du formulaire restent à sa charge, rien n'est créé automatiquement à
l'arrivée sur la page. Côté serveur, `routes/actionsRedactionLibre.ts`
accepte un champ optionnel `texte_initial` qui, s'il est fourni, remplace le
gabarit par défaut (`gabaritPour()`) comme contenu initial de l'`Action` —
extension minimale, ciblée, de la route déjà existante.

## Déviation par rapport au prompt : emplacement du hook post-upload

Le prompt indiquait `services/stockageDocuments.ts` comme fichier à modifier
pour le hook post-upload. En pratique, `enregistrerFichier()` (ce module)
est appelée **avant** la création de l'enregistrement `DocumentDossier` en
base (voir `routes/documentsDossier.ts`) : l'identifiant du document,
nécessaire pour créer la ligne `OcrResultat`, n'existe donc pas encore à cet
endroit. Le hook (`enqueuerTraitementOcr(document, contenu)`, jamais
`await`-é) a été placé dans `routes/documentsDossier.ts`, juste après
`prisma.documentDossier.create()` — exactement le même point d'insertion que
`enqueuerSyncEvenement()` au Lot 12b (appelé depuis la route, pas depuis un
service de plus bas niveau). `stockageDocuments.ts` n'est donc pas modifié,
uniquement réutilisé (`lireFichier`, déjà exporté).

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié — `OcrResultat`, enum `OcrStatut`,
  `DocumentDossier.ocrResultat`)
- `backend/prisma/migrations/20260811000000_ocr_resultats/migration.sql`
  (nouveau)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/services/ocr/detectionScanne.ts`,
  `moteurTesseract.ts` (nouveaux)
- `backend/src/jobs/traitementOcr.ts` (nouveau)
- `backend/src/routes/ocr.ts` (nouveau)
- `backend/src/routes/documentsDossier.ts` (modifié — hook post-upload,
  `ocrResultat` ajouté à `INCLUDE_STANDARD` pour le badge de statut sans
  requête supplémentaire par pièce)
- `backend/src/routes/actionsRedactionLibre.ts` (modifié — `texte_initial`
  optionnel)
- `backend/src/app.ts`, `backend/src/index.ts` (modifiés — enregistrement du
  routeur OCR, planification du cycle de rattrapage toutes les 5 minutes)
- `backend/public/dossier.html`, `backend/public/style.css` (modifiés —
  badge de statut, modale texte + score de confiance, barre de recherche
  plein texte, bouton "Copier vers un document en rédaction libre")
- `backend/public/nouvelle-action.html` (modifié — réception du texte copié,
  ouverture directe de l'écran "Rédiger librement")
- `backend/package.json` (modifié — `tesseract.js`, `pdf-to-png-converter`
  nouvelles dépendances)
- Tests : `src/services/ocr/__tests__/detectionScanne.test.ts` (8 tests),
  `src/services/ocr/__tests__/moteurTesseract.test.ts` (2 tests),
  `src/jobs/__tests__/traitementOcr.test.ts` (11 tests),
  `tests/e2e/ocr.test.ts` (8 tests)
- `README-LOT17.md` (ce fichier)

**Non modifiés** (vérifié) : `webActions.ts`, `documentExport.ts`,
`documentFormalisme.ts`, `services/stockageDocuments.ts` (uniquement
réutilisé), `gabaritsRedactionLibre.ts`.

## Ce qui a été réellement testé

Suite complète du projet rejouée après ce lot : **299/299 tests passés**
(39 fichiers de test), `tsc --noEmit` propre.

`detectionScanne.test.ts` (8 tests, unitaire, `pdf-parse` mocké — voir
"Incompatibilité `pdf-parse`/Vitest" ci-dessous) : image → toujours OCR ;
format hors périmètre → jamais d'OCR, `pdf-parse` jamais appelé ; PDF à texte
natif suffisant (2 pages) → pas d'OCR ; PDF quasiment vide → OCR nécessaire ;
seuil exact testé des deux côtés (juste en-dessous / juste au-dessus) ; PDF
illisible par `pdf-parse` → OCR tenté par prudence.

`moteurTesseract.test.ts` (2 tests, unitaire, sans mock) : rejet immédiat
d'un format non pris en charge, message clair, sans jamais démarrer le
moteur (le vrai chemin heureux Tesseract n'est pas couvert ici — voir
limites ci-dessous).

`traitementOcr.test.ts` (11 tests, unitaire, Prisma/stockage/moteur mockés,
**chiffrement réel** via une clé de test dédiée) : aucune ligne `OcrResultat`
créée pour un format hors périmètre ou un PDF à texte natif ; chiffrement
effectif du texte extrait avant écriture (`texteExtrait` commence par
`enc:v1:`, ne contient jamais le texte en clair) ; statut `echec` avec
message clair si le moteur échoue ; le hook ne rejette jamais même si Prisma
échoue ; relance manuelle : erreurs claires (document introuvable, format non
supporté, sans jamais toucher au moteur) et traitement en tâche de fond
(réponse avant la fin du traitement) ; cycle de rattrapage : reprend un
traitement bloqué, passe en échec proprement si le fichier original est
illisible ; absence de toute référence à `services/llm/` dans les trois
fichiers du module (import réel, pas un simple mot dans un commentaire).

`tests/e2e/ocr.test.ts` (8 tests, PostgreSQL réel, moteur OCR **non**
exercé — voir limites) : lecture du résultat OCR avec déchiffrement réel et
score de confiance ; statut `aucun` pour une pièce sans traitement (format
hors périmètre) ; permissions (autre cabinet → 404 sur les trois routes) ;
recherche plein texte trouve/ne trouve pas selon le terme, avec extrait
correct ; relance sur un format non supporté échoue proprement sans jamais
démarrer le moteur.

## Incompatibilité `pdf-parse` / Vitest (découverte pendant ce lot, sans rapport avec le code livré)

En écrivant `detectionScanne.test.ts`, `pdf-parse` s'est révélé plantant
systématiquement sous Vitest (`"bad XRef entry"`), **y compris sur un PDF
valide relu depuis le disque, sans aucun rapport avec ce module ni avec
`pdfkit`** — confirmé en isolant le problème à un test minimal n'important
que `pdf-parse` seul. La cause probable : le bundle webpack très ancien de
`pdf.js` (v1.10.100) embarqué par `pdf-parse` s'exécute différemment sous le
chargeur de modules de Vitest qu'en Node pur. C'est un problème
**pré-existant à ce lot** (`pdf-parse` est déjà utilisé en production par
`webActions.ts`/`resume_pdf` et `traduction.ts`, jusqu'ici jamais testé
directement avec un vrai fichier sous Vitest). `detectionScanne.test.ts`
mocke donc `pdf-parse` plutôt que de l'exercer réellement — solution plus
propre de toute façon (teste précisément le seuil, déterministe). **Ce
comportement n'affecte pas l'application réelle** (le mode d'exécution
production, `node dist/index.js` ou le binaire SEA, ne passe jamais par
Vitest) — signalé ici pour éviter une confusion si quelqu'un tente plus tard
d'écrire un test direct sur `resume_pdf` avec un vrai PDF.

## Non testé dans cet environnement

- **Le chemin heureux Tesseract réel** (image/PDF → texte reconnu avec un
  score de confiance) : nécessite un vrai moteur OCR, avec téléchargement
  réseau du pack de langue française au premier appel — non exercé en test
  automatisé (lent, dépendant du réseau, non déterministe). À valider
  manuellement : uploader une photo/un PDF scanné réel et vérifier
  l'apparition du texte et du score dans l'onglet Pièces.
- **Rasterisation PDF réelle** (`pdf-to-png-converter`) sur un PDF scanné
  multi-pages réel — non exercée en test automatisé, pour la même raison.
- **Empaquetage en exécutable portable** (risque principal identifié plus
  haut) : le binaire natif `@napi-rs/canvas` n'a pas été vérifié dans un
  build SEA réel — à faire avant toute diffusion.
- **Rendu visuel réel** du badge, de la modale et de la barre de recherche
  dans un navigateur — relu et syntaxiquement cohérent avec le reste de
  `dossier.html`, pas cliqué manuellement.
- **Score de confiance faible réel** (scan de mauvaise qualité) : l'affichage
  conditionnel de l'avertissement est couvert par une simple règle
  JavaScript (`score < 70`), pas par un vrai scan de mauvaise qualité passé
  dans Tesseract.
