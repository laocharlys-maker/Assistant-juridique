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

`DELETE` reste inchangé (suppression par `id` seul, jamais par groupe) —
non demandé par ce lot. **Limite connue, documentée mais non corrigée
ici** : supprimer un seul chunk d'une décision multi-chunkée laisse les
autres chunks du groupe en place (orphelins d'un groupe incomplet). À
traiter dans un lot séparé si jugé nécessaire.

**Autre limite connue (UI, non corrigée ici)** : `GET /api/jurisprudence-base`
renvoie toujours un enregistrement par chunk (jamais regroupé). Une
décision longue apparaît donc désormais comme plusieurs blocs distincts
dans la liste "Sources déjà indexées", partageant la même référence. Le
prompt initial ne demandait pas de refonte de cet affichage — non traité
pour rester dans le périmètre demandé.

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
- DELETE.

Complétés par des tests unitaires purs (aucune base requise) :
- `services/jurisprudence/__tests__/nettoyerTexte.test.ts` (8 tests) :
  recollage de mots coupés, préservation des vrais paragraphes,
  normalisation des espaces, suppression des en-têtes répétés (et
  non-suppression d'une ligne courte qui n'apparaît que 1-2 fois).
- `services/jurisprudence/__tests__/chunkerTexte.test.ts` (5 tests) :
  seuil respecté, découpage effectif au-delà, aucun chunk hors limite,
  chevauchement vérifié entre deux chunks consécutifs.

**218 tests unitaires + 7 tests route-level passent**, `tsc --noEmit` et
`npm run lint` propres (mêmes 5 erreurs préexistantes, aucune nouvelle).
Aucune régression sur `services/jurisprudence/grounding.ts`/`verifierLien.ts`
(Lot 13) — non modifiés, tests existants toujours au vert.

## Contraintes respectées

- Pas de champ `cabinetId` ajouté (base globale, cohérent avec le reste du
  produit desktop mono-cabinet).
- Permissions d'accès inchangées (titulaire/avocat/collaborateur, tous
  autorisés) — aucune raison de sécurité concrète identifiée pour les
  restreindre.
- `grounding.ts`/`verifierLien.ts` non modifiés.
- Import PDF : confort de saisie uniquement, même chemin de validation que
  la saisie manuelle, jamais de soumission automatique.
