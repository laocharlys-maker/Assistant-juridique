# Lot 18 — Fiabiliser l'indexation de la base de jurisprudence

Corrige quatre lacunes identifiées par audit sur `routes/jurisprudenceBase.ts`
et `public/jurisprudence-base.html` (l'écran "Jurisprudence" du menu
principal, où titulaire/avocat/collaborateur ajoutent manuellement une
décision à la base RAG interne) : absence de chunking, absence de
nettoyage du texte, sécurité du SQL brut non confirmée, et zéro couverture
de test.

## 1. Résultat de l'audit `$executeRawUnsafe` (priorité absolue de ce lot)

**Aucune vulnérabilité d'injection SQL.** Vérifié avant toute autre
modification, comme demandé.

Le `POST` existant appelait déjà `$executeRawUnsafe` avec des **paramètres
liés** (`$1` à `$8`), jamais une interpolation de valeur utilisateur dans la
chaîne SQL :

```ts
await prisma.$executeRawUnsafe(
  `INSERT INTO jurisprudence_chunks (id, source, reference, juridiction, date_decision, contenu, lien, embedding, created_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, now())`,
  id, source, reference, juridiction ?? null, dateDecision ?? null, contenu, lien || null, vectorLiteral
);
```

Le `PATCH` et le `DELETE` n'utilisaient de toute façon aucun SQL brut — API
Prisma Client standard (`updateMany`/`delete`), paramétrée automatiquement.

Conséquence : l'objectif 1 du prompt initial ("si l'audit révèle une
interpolation non paramétrée, corriger en priorité absolue") **ne
s'appliquait pas** — la prémisse n'était pas confirmée. Le mécanisme de
paramétrage est conservé tel quel (désormais extrait dans
`construireInsertionChunk()`, exportée, pour un test direct sans base
réelle — voir section 5).

## 2. Nettoyage du texte (`services/jurisprudence/nettoyerTexte.ts`)

Trois heuristiques simples, volontairement conservatrices (jamais de
parseur PDF structurel — le module ne connaît que le texte déjà extrait) :

1. **Espaces multiples** → normalisés en un seul espace.
2. **Mots/phrases coupés par la mise en page** : une ligne qui ne se
   termine pas par une ponctuation de fin (`.;:!?…"')]`) suivie d'une
   ligne commençant par une minuscule est recollée à la précédente —
   signe quasi certain d'une coupure de mise en page plutôt qu'une vraie
   fin de ligne voulue. Appliqué uniquement **à l'intérieur** d'un même
   paragraphe (jamais à travers un vrai saut de paragraphe, préservé).
3. **En-têtes/pieds de page répétés** : une ligne de 80 caractères ou
   moins qui apparaît **3 fois ou plus** à l'identique dans le texte est
   retirée. Simplification assumée par rapport à "intervalle régulier"
   (demandé dans le prompt initial) : détecter une vraie périodicité (ex.
   tous les ~40 lignes) demanderait de connaître la pagination d'origine,
   perdue une fois le texte extrait — une simple fréquence d'occurrence
   (≥ 3) est un indicateur fiable en pratique et beaucoup plus simple à
   auditer/tester.

## 3. Chunking (`services/jurisprudence/chunkerTexte.ts`)

**Seuil vérifié avant fixation, comme demandé** : `gemini-embedding-001`
accepte au maximum **2048 tokens** en entrée, avec **troncature silencieuse
par défaut** (`autoTruncate`, jamais désactivé dans ce projet) au-delà —
c'est exactement le risque identifié dans l'audit initial.

- Sources : [Gemini Enterprise Agent Platform — Text embeddings API](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/text-embeddings-api), [Get text embeddings — Vertex AI docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings).

Seuils retenus :
- **`SEUIL_CHUNKING_CARACTERES = 1500`** : en dessous, une décision reste un
  seul chunk (comportement inchangé pour une décision courte, comme
  demandé).
- **`TAILLE_CIBLE_CHUNK = 1200`** : découpage par paragraphe (`\n\s*\n`),
  jamais un objectif de "coller" à la limite du modèle — même avec une
  estimation pessimiste (~3 caractères/token pour du français juridique
  accentué), 1200 caractères ≈ 400 tokens, soit **plus de 5x de marge**
  sous les 2048 tokens. Un chunk plus petit améliore aussi la précision de
  la recherche par similarité (évite la dilution sémantique identifiée
  dans l'audit).
- **`CHEVAUCHEMENT_CARACTERES = 150`** : chaque chunk reprend la fin du
  précédent, pour qu'une idée à cheval sur la frontière de découpage reste
  entièrement présente dans au moins un chunk.

Le nettoyage (section 2) est toujours appliqué **avant** le chunking.

## 4. Regroupement multi-chunks (`groupeId`)

Migration additive `20260814000000_jurisprudence_groupe_id` : nouvelle
colonne nullable `groupe_id` sur `jurisprudence_chunks`. Un identifiant est
**systématiquement généré à chaque soumission du formulaire** (y compris
pour une décision courte restant un seul chunk) et partagé par tous les
chunks issus de cette soumission.

`PATCH /api/jurisprudence-base/:id` (modification du lien) résout d'abord
le `groupeId` du chunk visé, puis met à jour **tous** les chunks du groupe
en une seule opération (`updateMany({ where: { groupeId } })`). Pour le
corpus indexé **avant** ce lot (`groupeId` = `NULL`), repli automatique sur
une mise à jour par `id` seul — comportement identique à avant ce lot,
aucune régression sur les données existantes.

**Correctif (suite du Lot 18)** : `DELETE /api/jurisprudence-base/:id`
utilise désormais la même fonction de résolution de filtre que `PATCH`
(`construireFiltreGroupe`, partagée) — supprime **tous** les chunks du
groupe en une seule opération (`deleteMany({ where: { groupeId } })`),
jamais un seul chunk orphelin. Repli sur l'`id` seul pour le corpus
indexé avant ce lot (`groupeId` = `NULL`), même logique que `PATCH`.

**Correctif frontend (suite du Lot 18)** : `jurisprudence-base.html`
regroupe désormais l'affichage par décision (`groupeId`, repli sur `id`
pour le corpus legacy) — un seul bloc visuel par décision, comme avant ce
lot. Une décision à un seul chunk affiche son contenu intégral, inchangé.
Une décision multi-chunkée affiche un indicateur "N chunks" à côté de la
référence, et un aperçu résumé (concaténation des chunks, tronquée à 600
caractères) plutôt que le texte complet de chaque chunk. Le bouton
"Supprimer" et le formulaire d'ajout de lien utilisent l'`id` du premier
chunk du groupe — le backend cascade déjà sur tout le groupe, aucun autre
changement nécessaire.

## 5. Import PDF (confort de saisie)

`services/pdfExtraction.ts` — extraction `pdf-parse` factorisée, réutilisée
par `routes/webActions.ts` (résumé PDF, inchangé fonctionnellement) et la
nouvelle route `POST /api/jurisprudence-base/extraire-pdf`.

Le bouton "Importer depuis un PDF" (`jurisprudence-base.html`) appelle
cette route et **pré-remplit uniquement le champ "contenu"** du
formulaire. Aucune soumission automatique : l'avocat relit/corrige puis
clique lui-même "Indexer dans la base", qui suit ensuite exactement le
même chemin (nettoyage → chunking → embedding) que la saisie manuelle.

## 6. Tests

**Contrainte d'environnement découverte en préparant les tests** : le
cluster PostgreSQL éphémère utilisé par les tests e2e de ce projet
(`tests/e2e/helpers/testPostgres.ts`) **retire délibérément l'extension
`vector` et la colonne `embedding`** avant d'appliquer le schéma —
limitation documentée de longue date (pgvector ne peut pas être compilé
sans Visual Studio Build Tools sur cette machine, même contrainte que les
Lots 2/2bis/3/5/6). Un test e2e classique sur ce cluster ne peut donc
**jamais** exercer le vrai `INSERT` de `jurisprudenceBase.ts` (qui
référence une colonne `embedding` absente de ce schéma de test).

Stratégie retenue en conséquence — `src/routes/__tests__/jurisprudenceBase.test.ts` :
Prisma et l'authentification (`requireAuth`/`requireModule`) **mockés**,
serveur Express minimal ne montant que ce routeur, requêtes HTTP réelles
(`fetch`). Couvre :
- POST avec contenu court → 1 chunk, 1 appel `embedText`, 1 `INSERT`.
- POST avec contenu long → plusieurs chunks (même `groupeId` partagé,
  aucun chunk > 1800 caractères).
- **Absence d'injection SQL** : une valeur contenant `'; DROP TABLE ...; --`
  n'apparaît jamais dans la chaîne SQL elle-même (uniquement des
  placeholders `$1..$9`), uniquement comme paramètre lié.
- PATCH sur une décision multi-chunkée (tous les chunks du groupe mis à
  jour) et sur le corpus legacy sans `groupeId` (repli par id).
- DELETE, y compris sur une décision multi-chunkée : supprime **tous** les
  chunks du groupe, aucune ligne orpheline (régression corrigée dans ce
  même lot).

Complétés par des tests unitaires purs (aucune base requise) :
- `services/jurisprudence/__tests__/nettoyerTexte.test.ts` (8 tests) :
  recollage de mots coupés, préservation des vrais paragraphes,
  normalisation des espaces, suppression des en-têtes répétés (et
  non-suppression d'une ligne courte qui n'apparaît que 1-2 fois).
- `services/jurisprudence/__tests__/chunkerTexte.test.ts` (5 tests) :
  seuil respecté, découpage effectif au-delà, aucun chunk hors limite,
  chevauchement vérifié entre deux chunks consécutifs.

**218 tests unitaires + 9 tests route-level passent** (7 initiaux + 2
ajoutés pour la cascade DELETE multi-chunks), `tsc --noEmit` et
`npm run lint` propres (mêmes 5 erreurs préexistantes, aucune nouvelle).
Aucune régression sur `services/jurisprudence/grounding.ts`/`verifierLien.ts`
(Lot 13) — non modifiés, tests existants toujours au vert.

## 7. Vérification manuelle avec pgvector réel (non mocké)

Faite après coup, comme demandé, en environnement de dev réel — jamais
contre la base du cabinet : création d'une base Postgres **isolée et
jetable** (`aurore_lot18_verif`) sur le même serveur portable pgvector que
l'installation desktop de développement (binaires `vendor/postgres/win-x64`,
extension `vector` réellement compilée, contrairement au cluster des
tests e2e — voir section 6), schéma appliqué depuis
`prisma/portable-init.sql` à jour (Lot 18 inclus), backend lancé en
conditions réelles (`tsx src/index.ts` équivalent) avec une vraie
`GEMINI_API_KEY`.

Déroulé et résultat :

1. **`POST /api/jurisprudence-base`** avec un vrai texte de décision
   (bail commercial, clause résolutoire) → `201`, `chunkCount: 1`,
   `groupeId` généré.
2. **Vérification directe en base** (`pg_typeof`, `vector_dims`) :
   ```
   embedding_type = 'vector'   embedding_non_null = true   dimensions = 3072
   ```
   Confirme un vrai embedding Gemini (`gemini-embedding-001`, 3072
   dimensions par défaut sans `outputDimensionality` — cohérent avec la
   section 3), jamais `NULL`, correctement typé `vector` (pas du texte ou
   un tableau générique).
3. **Recherche par similarité** (`searchJurisprudence()`, la même
   fonction utilisée par le Lot 13/Recherche de jurisprudence) : la
   décision de test est retrouvée (1 résultat, distance ≈ 0.41) via une
   requête reformulée différemment de la saisie d'origine — confirme que
   la chaîne complète indexation → recherche fonctionne de bout en bout
   avec un vrai embedding, pas seulement au niveau structure de données.
4. **`DELETE`** sur ce chunk de test → `chunksSupprimes: 1`, `0` ligne
   restante pour ce `groupeId` — confirme le correctif de la section 4 en
   conditions réelles, pas seulement mocké.

Base de test et script de vérification supprimés après coup (jamais
commis, jamais de trace dans le corpus réel du cabinet).

## 8. Passerelle résumé PDF → base de jurisprudence

Objectif additionnel : le traitement `resume_pdf` (`routes/webActions.ts`)
traitait le PDF uploadé **uniquement en mémoire**, jamais persisté. Ce lot
ajoute la persistance **au moment du dépôt initial uniquement** (jamais
après coup) — aucun état temporaire à purger différemment.

**Formulaire (`public/nouvelle-action.html`)** : case à cocher "Ajouter
aussi cette décision à ma base de jurisprudence" sur le formulaire de
résumé PDF. Si cochée, affiche immédiatement les champs référence
(obligatoire) / juridiction / date de la décision — les mêmes que
`jurisprudence-base.html` — à remplir par l'avocat **avant** de soumettre.

**Traitement (`routes/webActions.ts`, branche `resume_pdf`)** — un seul
appel, un seul traitement du PDF :
1. Extraction du texte (`pdf-parse`, inchangé) et génération du résumé
   (LLM, inchangé) — comportement identique dans tous les cas.
2. **Si la case était cochée**, dans la même requête : génère un `groupeId`,
   construit le lien interne (`construireLienInterneDocument`), stocke le
   PDF chiffré (`services/jurisprudence/stockagePdf.ts`, qui réutilise
   `stockageDocuments.ts` du Lot 15 via un "bucket" conventionnel
   `"jurisprudence-base"` — aucun `Dossier` applicatif créé), crée la ligne
   `JurisprudencePdf` (nouveau modèle, une ligne par décision/`groupeId`),
   puis appelle `indexerDecision()` (nettoyage → chunking → embedding →
   insertion, **extrait de `jurisprudenceBase.ts` dans
   `services/jurisprudence/indexerDecision.ts`** pour être partagé par les
   deux points d'entrée sans dupliquer la logique).
3. Le champ `contenu` indexé est **toujours le texte brut extrait, nettoyé**
   — jamais le résumé généré par le LLM, qui reste un affichage de confort
   distinct (voir `indexerDecision()`, paramètre `contenuBrut` explicite).
4. **Si la case n'est pas cochée** : rien de stocké, rien en base au-delà du
   résumé habituel — comportement strictement inchangé (vérifié par test,
   voir ci-dessous).
5. **Échec de l'indexation en cours de route** (ex: quota Gemini épuisé
   après le stockage du fichier) : nettoyage explicite (fichier physique +
   ligne `JurisprudencePdf` + éventuels chunks déjà insérés retirés), le
   résumé reste néanmoins généré et renvoyé normalement à l'avocat — l'ajout
   à la base de jurisprudence est un effet secondaire optionnel, son échec
   ne doit jamais faire perdre le résumé demandé. Le résultat
   (`jurisprudenceIndexation: { ok, erreur? }`) est renvoyé au frontend, qui
   affiche une confirmation ou un message d'erreur explicite sans faire
   disparaître le résumé déjà affiché.

**Consultation du PDF stocké** : nouvelle route interne
`GET /api/jurisprudence-base/:groupeId/document` (authentifiée, même
protection de module que le reste de `jurisprudenceBase.ts`), qui déchiffre
et sert le fichier. C'est **cette route**, jamais une URL web, qui est
enregistrée comme champ `lien` des chunks créés.

**`verifierLien.ts` (Lot 13) étendu** : un lien au format
`/api/jurisprudence-base/:groupeId/document` est désormais reconnu comme
**interne** (`extraireGroupeIdDuLienInterne`) et vérifié par un **test
d'existence du fichier stocké** (`pdfJurisprudenceExiste`, via
`stockageDocuments.ts`) — **jamais par une requête HTTP sortante**, il n'y a
rien à joindre sur le réseau. Toute URL web classique continue de suivre le
chemin HTTP existant, inchangé.

**Suppression cohérente** : `DELETE /api/jurisprudence-base/:id` (section 4)
retire désormais aussi le PDF stocké et sa métadonnée `JurisprudencePdf`
quand la décision supprimée en a un — jamais de PDF chiffré orphelin sur
disque après suppression d'une décision issue de cette passerelle.

**Migration additive** : `20260814010000_jurisprudence_pdf` — nouvelle table
`jurisprudence_pdfs` (`groupe_id` en clé primaire, `nom_fichier`,
`nom_original`, `taille_octets`, `created_at`). Aucun impact sur le corpus
existant (une décision saisie manuellement ou important un PDF juste comme
confort de saisie, voir section 5, n'a jamais de ligne dans cette table).

**Tests** — `src/routes/__tests__/webActions.resumePdf.test.ts` (route-level,
mêmes principes que la section 6 : Prisma/LLM/embeddings/stockage mockés,
HTTP réel sur un serveur Express minimal) :
- case décochée → aucun fichier stocké, aucune métadonnée créée, `embedText`
  jamais appelé.
- case cochée sans référence → `400` explicite, rien de stocké.
- case cochée avec référence → stockage + indexation en un seul appel,
  contenu inséré = texte brut extrait (**jamais** le résumé généré),
  `jurisprudenceIndexation.lien` au format interne attendu.
- échec de l'indexation (embedding en erreur) → résumé quand même renvoyé,
  fichier stocké et métadonnées nettoyés (aucun état orphelin).

Complétés par :
- `services/jurisprudence/__tests__/stockagePdf.test.ts` (3 tests) : aller-
  retour lien interne ↔ `groupeId`, rejet des URL web classiques et des
  formats proches mais invalides.
- `services/jurisprudence/__tests__/indexerDecision.test.ts` (3 tests) :
  génération automatique du `groupeId` vs réutilisation d'un `groupeId`
  fourni par l'appelant, contenu inséré = texte nettoyé (jamais transformé).
- `services/jurisprudence/__tests__/verifierLien.test.ts` (+3 tests) : lien
  interne accessible sans requête HTTP, fichier manquant sur disque,
  métadonnée absente (décision déjà supprimée).
- `src/services/__tests__/stockageDocuments.test.ts` (+1 test) :
  `existeFichier()` reflète écriture/suppression sans déchiffrer.
- `src/routes/__tests__/jurisprudenceBase.test.ts` (+2 tests) : `DELETE`
  retire bien le PDF stocké associé, et ne touche jamais `JurisprudencePdf`
  pour une décision sans PDF (corpus saisi manuellement).

Suite complète : `396` tests passent (`6` skips préexistants, sans rapport
avec ce lot), `tsc --noEmit` et `npm run lint` propres sur tous les fichiers
touchés (les 5 erreurs de lint préexistantes ailleurs dans le projet sont
inchangées). Un seul échec observé sur la suite complète —
`tests/e2e/network-mode.test.ts` (timeout de hook au démarrage d'un second
serveur) — sans rapport avec ce lot (aucune référence à jurisprudence/
resume_pdf/stockagePdf dans ce fichier), reproductible même hors de toute
modification de ce lot en relançant la suite complète sous charge.

## Contraintes respectées

- Pas de champ `cabinetId` ajouté (base globale, cohérent avec le reste du
  produit desktop mono-cabinet).
- Permissions d'accès inchangées (titulaire/avocat/collaborateur, tous
  autorisés) — aucune raison de sécurité concrète identifiée pour les
  restreindre.
- `grounding.ts` non modifié. `verifierLien.ts` étendu (section 8,
  passerelle resté PDF → jurisprudence) pour reconnaître un lien interne
  et le vérifier par test d'existence de fichier — son chemin HTTP existant
  pour les URL web classiques reste, lui, strictement inchangé.
- Import PDF (section 5) : confort de saisie uniquement, même chemin de
  validation que la saisie manuelle, jamais de soumission automatique.
- Passerelle résumé PDF → jurisprudence (section 8) : persistance
  uniquement au moment du dépôt initial, jamais d'état intermédiaire ni de
  purge différée ; contenu indexé toujours le texte brut, jamais le résumé.
