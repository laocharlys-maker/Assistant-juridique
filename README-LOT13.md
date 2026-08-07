# Lot 13 : jurisprudence sourcée — grounding strict + liens réels vérifiés

Durcit le module Recherche juridique / Jurisprudence existant (RAG
`JurisprudenceChunk` + Tavily) contre deux risques : une décision citée qui
n'existe pas ("hallucination de citation"), et une décision citée qui existe
mais dont l'avocat ne peut pas vérifier la source faute de lien réel. Ne
touche à aucune logique métier de génération d'actes, ni à la mécanique de
récupération par similarité (pgvector) ou à l'intégration Tavily elle-même.

## Vérification du schéma (faite en premier, comme demandé)

`JurisprudenceChunk` n'avait **aucun** champ URL/lien avant ce lot - vérifié
en lisant `prisma/schema.prisma` : le champ `source` existant est un
**libellé** ("Cour Suprême du Bénin", "OHADA"...), jamais une URL. Champ
`lien` (`String?`, nullable) ajouté par
`prisma/migrations/20260807040000_jurisprudence_lien/migration.sql`.

**Impact sur le corpus existant** : tous les chunks indexés avant ce lot ont
`lien = NULL`. Le nombre exact n'a pas pu être mesuré dans cet environnement
de développement (pas de base de production accessible ici) - pour
l'obtenir : `SELECT count(*) FROM jurisprudence_chunks WHERE lien IS NULL;`.
**Conséquence directe et volontaire** : tant qu'un chunk n'a pas de lien
renseigné, **aucune citation qui s'appuierait sur lui n'est jamais affichée**
dans une recherche de jurisprudence (retirée avec le message standard, log
distinct `lien_manquant` - voir plus bas) - le texte de la source reste
utilisable pour orienter la rédaction du LLM, mais sa citation nommée
disparaît de l'affichage si non sourcée par un lien. **Recommandation** :
prioriser l'ajout du lien sur les chunks les plus fréquemment pertinents
(jurisprudence béninoise/OHADA récente). Un écran dédié le permet
directement sans réindexation : `/jurisprudence-base.html` signale
désormais en rouge chaque source sans lien, avec un formulaire d'ajout
immédiat (`PATCH /api/jurisprudence-base/:id`, nouvelle route - ne touche ni
au contenu ni à l'embedding déjà calculé).

## Logique de validation retenue

### 1. Détection des citations : marqueur structurel, pas une regex sur texte libre

Le prompt système (`JURISPRUDENCE_SYSTEM_PROMPT`) impose désormais au LLM de
faire suivre **immédiatement** chaque décision citée du marqueur exact
`[REF: Source N]`, où `N` est l'index **exact** de la source dans une liste
**unique et numérotée en continu** (voir ci-dessous). La détection
(`grounding.ts`) est donc une simple recherche par **index numérique**, pas
une comparaison de texte : ni fuzzy matching, ni risque qu'une hallucination
"proche" d'une vraie référence soit validée par erreur - c'est structurellement
impossible avec ce design (soit l'index existe dans la liste des sources
réellement récupérées, soit non).

**Changement nécessaire pour rendre cela fiable** : avant ce lot,
`buildJurisprudenceUserPrompt()` recevait `sourcesWeb` et `sourcesCabinet`
formatés **séparément**, chacun avec sa propre numérotation `[Source 1]`,
`[Source 2]`... - un marqueur `[REF: Source 1]` aurait donc été ambigu (la
source cabinet 1 ou la source web 1 ?). `construireSourcesDisponibles()`
fusionne maintenant les deux (cabinet d'abord, puis web) en **une seule**
liste à numérotation continue, formatée par `formatSourcesPourPrompt()` -
`buildJurisprudenceUserPrompt()` a été mis à jour en conséquence (un seul
paramètre `sources` au lieu de deux). `formatJurisprudenceContext()` et
`formatWebSearchContext()` restent inchangées et toujours utilisées telles
quelles ailleurs (veille juridique, recherche juridique générale).

### 2. Vérification en 2 temps, jamais de blocage de la réponse

Pour chaque référence citée (`validerEtFiltrerCitations()`) :
1. **Grounding** : l'index existe-t-il dans les sources réellement
   récupérées pour cette requête précise ? Sinon → `hallucination`.
2. **Lien** : la source a-t-elle un `lien` renseigné (`JurisprudenceChunk.lien`
   ou URL Tavily, jamais une URL extraite du texte du LLM) ? Sinon →
   `lien_manquant`.
3. **Accessibilité** : le lien répond-il en HTTP (`verifierLien.ts`) ?
   Sinon → `lien_inaccessible`.

Dans les 3 cas, la citation est retirée du texte affiché (marqueur `[REF: ...]`
remplacé par `*(référence non vérifiée)*`, pour ne jamais laisser une phrase
présenter une décision comme confirmée sans l'être) et un avertissement
unique est ajouté en fin de réponse **seulement s'il y a eu au moins un
rejet** : *"Une partie de l'analyse n'a pas pu être sourcée avec un lien
vérifié."* Le texte d'analyse reste toujours affiché - jamais de réponse
vide (contrainte explicite du prompt).

**Défense en profondeur contre un lien halluciné par le LLM** : le prompt
interdit formellement au LLM d'écrire une URL, mais le texte n'est de toute
façon **jamais** la source d'un lien affiché - le lien vient uniquement de
l'objet `SourceDisponible` retrouvé par index. En complément, toute URL brute
qui apparaîtrait quand même dans le texte généré est systématiquement
neutralisée (`[lien retiré]`) avant affichage, qu'elle corresponde ou non à
une vraie source.

### 3. Bloc "Source" distinct

`Action.champsDocument.sourcesJurisprudence` (nouveau, uniquement pour le
type `jurisprudence`) stocke les sources validées (référence, juridiction,
date, lien) au moment de la génération - figées comme le reste de
`champsDocument`, jamais recalculées à la relecture. Le frontend
(`nouvelle-action.html` juste après génération, `dossier.html` à la
réouverture du document) affiche un bloc `.source-block` visuellement
distinct (bordure de couleur, fond différent) du texte Markdown généré par
l'IA, avec le lien **toujours cliquable** - jamais de mention "si
disponible" : une source sans lien n'atteint jamais ce rendu.

## Domaines de confiance Tavily (déjà en place, documenté ici)

La restriction recommandée par le prompt **existait déjà** avant ce lot
(`webActions.ts`, `searchWebPrioritaire()`) - vérifié, aucune modification
nécessaire. Pour la recherche de jurisprudence :

```
tcc.justice.bj, coursupreme.bj, jurisprudencebenin.org, juricaf.org,
ahjucaf.org, ohada.org, actualitesdroitohada.com, ca-cot.justice.bj,
justice.gouv.bj
```

Une recherche Tavily restreinte à ces domaines est lancée en parallèle d'une
recherche générale plus large ; les résultats des domaines de confiance sont
placés en premier, dédupliqués par URL. Choisis avec le cabinet : sites de
cours officielles et bases juridiques structurées, pas de pages
généralistes.

## Politique de cache (vérification de lien)

En mémoire (`Map<url, VerificationLien>`), TTL de **6 heures** - assez court
pour détecter un lien qui tombe en panne dans un délai raisonnable, assez
long pour éviter de re-tester le même lien à chaque recherche similaire
(plusieurs recherches sur un thème proche recoupent souvent les mêmes
sources). Perdu au redémarrage du serveur (pas de persistance) - acceptable
pour un cache de courte durée, pas un besoin de durabilité. Les
vérifications sont **parallélisées** (`Promise.all`), jamais séquentielles,
et **uniquement pour les sources effectivement citées** (jamais toutes les
sources récupérées) - vérifié par test de performance (8 tests, dont un qui
mesure le temps réel et confirme la parallélisation).

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié - `JurisprudenceChunk.lien`)
- `backend/prisma/migrations/20260807040000_jurisprudence_lien/migration.sql` (nouveau)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/services/jurisprudence/{grounding,verifierLien}.ts` (nouveaux)
- `backend/src/services/rag.ts` (modifié - `lien` sur `JurisprudenceMatch` et la requête SQL)
- `backend/src/routes/jurisprudenceBase.ts` (modifié - `lien` en création + nouvelle route `PATCH` pour compléter le lien d'une source existante)
- `backend/src/prompts/webRedaction.ts` (modifié - `JURISPRUDENCE_SYSTEM_PROMPT` renforcé, `buildJurisprudenceUserPrompt` unifié)
- `backend/src/routes/webActions.ts` (modifié - branche `jurisprudence` : sources unifiées, grounding post-génération, `champsDocument.sourcesJurisprudence`, réponse HTTP enrichie)
- `backend/public/jurisprudence-base.html` (modifié - champ lien à la création, édition inline pour les sources existantes)
- `backend/public/nouvelle-action.html`, `backend/public/dossier.html` (modifiés - bloc "Source" distinct)
- `backend/public/style.css` (modifié - `.source-block`)
- Tests : `src/services/jurisprudence/__tests__/{grounding,verifierLien}.test.ts` (20 tests)
- `README-LOT13.md` (ce fichier)

**Non modifiés** (vérifié) : `webActions.ts` (hors la branche `jurisprudence`
elle-même), `documentExport.ts`, `services/rag.ts` (mécanique de similarité
pgvector inchangée, seul le champ `lien` traverse la requête existante),
`services/tavily.ts` (intégration Tavily inchangée), `formatJurisprudenceContext`/
`formatWebSearchContext` (toujours utilisées telles quelles ailleurs).

## Ce qui a été réellement testé

Suite complète du projet rejouée : **185/185 tests passés**, `tsc --noEmit`
propre, `eslint` sans nouvelle erreur (3 erreurs préexistantes, hors
fichiers de ce lot).

`grounding.test.ts` (12 tests, unitaire, fonction pure + `verifierLienFn`
injectable) - couvre exactement les 8 scénarios du prompt : référence valide
+ lien accessible (bloc Source correct), référence hallucinée (retrait +
message), référence valide + lien mort (retrait + log `lien_inaccessible`),
chunk RAG sans lien (retrait + log `lien_manquant`, **sans requête HTTP
inutile**), lien halluciné par le LLM dans le texte (toujours le lien de la
source qui s'affiche, jamais celui du LLM), aucune citation (réponse
inchangée, pas de bloc superflu), cohérence indépendante du style
rédactionnel (proxy pour "indépendant du `LLM_PROVIDER`", qui n'intervient
jamais dans cette couche - voir limite ci-dessous), performance
(vérifications mesurées comme réellement parallèles, pas 2×30ms mais <55ms
pour 2 liens).

`verifierLien.test.ts` (8 tests, unitaire, `fetch` mocké) - HEAD réussi,
404 traité comme inaccessible, repli sur GET si HEAD renvoie un statut non
concluant (403) ou échoue complètement, erreur réseau persistante, URL
syntaxiquement invalide (aucune requête réseau), mise en cache (un second
appel ne refait pas de requête), vérification multiple parallélisée et
dédupliquée.

## Limite assumée : pas de test e2e de bout en bout sur `webActions.ts`

La branche `jurisprudence` de `POST /api/actions/web` n'est **pas** couverte
par un test e2e dédié dans ce lot : la reproduire fidèlement exigerait de
mocker simultanément le fournisseur LLM, Tavily, **et** `embedText()`
(embeddings Gemini, nécessaires à `searchJurisprudence()` même quand
`LLM_PROVIDER` n'est pas Gemini) - un montage plus fragile qu'utile au vu de
ce qu'il testerait réellement : le câblage dans `webActions.ts` est un appel
direct d'une dizaine de lignes vers des fonctions déjà testées de façon
approfondie (`construireSourcesDisponibles`, `formatSourcesPourPrompt`,
`validerEtFiltrerCitations`). Compensé par : relecture manuelle du câblage,
`tsc --noEmit` propre (les signatures/types sont garantis cohérents), et le
test "Test 7" de `grounding.test.ts` qui démontre que la couche de
validation elle-même ne dépend jamais du fournisseur LLM actif (elle
n'importe ni n'appelle aucun code de `services/llm/*`).

## Non testé dans cet environnement

- **Connexion réseau réelle** vers un vrai site de jurisprudence (JURICAF,
  Cour Suprême du Bénin...) pour vérifier qu'un lien réel y répond bien -
  tous les tests HTTP sont mockés (pas d'accès réseau sortant garanti dans
  cet environnement).
- **Rendu visuel réel** du bloc "Source" dans un navigateur - relu et
  syntaxiquement validé (`node --check`), pas cliqué.
- **Mesure réelle du nombre de chunks sans lien** sur la base de production
  du cabinet (voir requête SQL fournie plus haut).
