# Lot 5 : pseudonymisation avant appel LLM

> **Mise à jour ultérieure** : la distinction ✅/❌ ci-dessous (notamment
> `assignation`, `conclusions`, `note_plaidoirie`, `redac`) documentait un
> choix de conception qui s'est révélé incorrect en pratique (voir bug de
> parties inversées sur les Conclusions) et a été abandonné : ces quatre
> types passent désormais eux aussi par `redigerAvecPseudonymisation()`.
> Consigne actuelle, sans exception : tout type d'acte qui manipule un nom
> de client/partie adverse/destinataire doit tokeniser cette identité avant
> l'appel LLM. Le reste de ce document (mécanisme, conventions de nommage,
> fail-safe) reste exact.

Empêche les données identifiantes des clients du cabinet de transiter en
clair vers le LLM externe (Anthropic/Gemini/Groq) : les valeurs
identifiantes connues sont remplacées par des tokens neutres avant l'appel,
puis re-substituées par les vraies valeurs après réception - avec un
mécanisme fail-safe qui bloque la génération plutôt que de livrer un
document avec un token resté visible.

Aucune modification de `documentExport.ts`, `documentFormalisme.ts`,
`markdownParse.ts`, `services/llm/` - vérifié via `git status` avant
livraison (voir liste des fichiers touchés en fin de document).

## Où l'intégration s'applique réellement (et pourquoi)

Le prompt décrit "deux points d'insertion précis (avant l'appel LLM, après
la réponse LLM)". C'est exactement le cas **pour un flux de génération
donné** - mais `webActions.ts` (route `POST /api/actions/web`) contient en
réalité **14 appels `.redact()` indépendants**, un par branche
`if/else if (form.type_action === ...)`, chacune avec sa propre
construction de prompt. Il n'existe donc pas de point d'insertion unique
pour tout le fichier : le motif "avant/après l'appel LLM" est appliqué à
**chaque branche concernée**, de façon minimale et mécanique (voir
`redigerAvecPseudonymisation()` ci-dessous, qui encapsule exactement ces
deux points en un seul appel de fonction par branche).

**Important - ceci n'est PAS une distinction "avec template" vs "sans
template" : les 16 types d'actes utilisent tous un template** (page de
garde, formule d'ouverture, signature... jamais rédigés par l'IA). La
distinction porte uniquement sur **ce qui est physiquement inclus dans le
texte du prompt envoyé au LLM** - déterminé en lisant, pour chaque type,
la signature exacte de `buildXxxUserPrompt(facts: {...})` dans
`src/prompts/webRedaction.ts` (quels champs `facts` accepte réellement,
donc quelles chaînes de caractères sont interpolées dans le prompt), pas
supposé. Exemple concret :

```ts
// buildAssignationUserPrompt (Assignation) - AUCUN champ de nom de partie
// dans "facts" : le nom du demandeur/défendeur n'est jamais interpolé
// dans le texte envoyé au LLM, il n'y a donc rien a tokeniser ici.
export function buildAssignationUserPrompt(facts: {
  nomAffaire: string; contexte: string; axesArgumentation: string[];
  demandeClient?: string; fondementJuridique?: string; ...
}): string { ... }

// buildNotesUserPrompt (compte-rendu) - le nom EST un champ de "facts",
// donc il apparait litteralement dans le texte envoye au LLM
// (`Client : ${facts.nomClient}`) : c'est ce cas qui a besoin d'un token.
export function buildNotesUserPrompt(facts: {
  nomClient: string; nomJuge?: string; nomGreffier?: string; ...
}): string { ... }
```

Pour l'Assignation/Conclusions/Note de plaidoirie, l'identité des parties
("I. LES PARTIES" sur la page de garde) est bien insérée dans le document
final **par le code**, à partir de `champsDocument` - exactement comme pour
tous les autres types - mais dans CES trois cas précis, cette insertion se
fait **sans jamais passer par le LLM** (le nom n'est simplement pas un
paramètre de la fonction qui construit le prompt). Pour les 7 types
marqués ✅ ci-dessous, le nom réel est au contraire directement interpolé
dans la chaîne de texte lue et reformulée par le LLM - c'est uniquement
dans ces 7 cas que la pseudonymisation a quelque chose à protéger.

| Type d'acte | Champ(s) identifiant(s) envoyés au LLM | Concerné |
|---|---|---|
| `notes` (compte-rendu) | `nomClient`, `nomPartieAdverse`, `nomJuge`, `nomGreffier` | ✅ |
| `mise_en_demeure` | `destinataire` | ✅ |
| `plainte` | `nomDefendeur` | ✅ |
| `contrat` | `partie1`, `partie2`, `informationsPartie1`, `informationsPartie2` | ✅ |
| `notification_date` | `destinataire` | ✅ |
| `requete` | `destinataire` (composé, peut contenir un nom réel via le cas "Maître") | ✅ |
| `projet_ordonnance` | `destinataire` (idem requête) | ✅ |
| `assignation`, `conclusions`, `note_plaidoirie` | *aucun* - même template, mêmes champs `champsDocument` renseignés, mais le nom des parties n'est pas un paramètre de `buildXxxUserPrompt()` pour ces trois types : il n'atteint donc jamais le LLM | ❌ |
| `redac` (plaidoirie) | `destinataire`/`adresseA` existent dans le builder mais ne sont **jamais passés** à l'appel actuel dans `webActions.ts` | ❌ |
| `jurisprudence`, `recherche_juridique`, `veille_juridique`, `resume_pdf`, `traduction` | Pas de champsDocument identitaire dans le prompt (recherche/résumé/traduction de texte, pas de parties) | ❌ |

Vérifié par lecture exhaustive de `src/prompts/webRedaction.ts` (toutes les
signatures `buildXxxUserPrompt(facts: {...})`) et de chaque branche de
`webActions.ts` correspondante - pas une supposition.

## Champs identifiants tokenisés (pour audit)

Documentés en tête de `security/anonymizer.ts`. Correspond à la liste
donnée par le prompt (nom, adresse, numéro d'identifiant) - **jamais** les
dates de procédure, la juridiction, le type d'acte, ou le texte narratif
(contexte, axes d'argumentation, faits) : ces derniers ne sont **jamais**
scannés heuristiquement (pas de NER/NLP dans ce lot, conformément à la
contrainte du prompt).

| Champ (nom logique) | Rôle du token | Provenance |
|---|---|---|
| `nomClient`, `nomPartieAdverse`, `nomDefendeur`, `destinataire`, `partie1`, `partie2` | `PARTIE` | Identité d'une personne physique/morale |
| `nomJuge` | `JUGE` | Identité d'un magistrat |
| `nomGreffier` | `GREFFIER` | Identité d'un greffier |
| `informationsPartie1`, `informationsPartie2` | `IDENTIFIANT` | État civil ou numéro RCCM/IFU d'une partie à un contrat |

Rôles prévus mais non utilisés dans les branches actuelles de
`webActions.ts` (module générique, prêt si un futur champ `adresse`,
`nomHuissier`, `telephone` ou `email` est un jour passé au LLM) : `ADRESSE`,
`HUISSIER`, `TELEPHONE`, `EMAIL`.

## Convention de nommage des tokens

- Rôle `PARTIE` → suffixe **lettre**, dans l'ordre de première apparition :
  `PARTIE_A`, `PARTIE_B`, `PARTIE_C`... (au-delà de Z : `PARTIE_AA`,
  `PARTIE_AB`..., jamais de plafond silencieux).
- Tous les autres rôles → suffixe **numérique** : `JUGE_1`, `JUGE_2`,
  `GREFFIER_1`, `IDENTIFIANT_1`...
- **Stabilité** : une même valeur réelle (comparaison texte exact, après
  `trim()`) reçoit toujours le même token, y compris si elle apparaît sous
  plusieurs champs ou plusieurs fois dans le texte du prompt.
- **Parties multiples** : chaque valeur *distincte* sous un même rôle reçoit
  son propre token (`PARTIE_A`, `PARTIE_B`, `PARTIE_C`...) - couvert par les
  tests (`anonymizer.test.ts`, "parties multiples").
- Une valeur vide/absente n'est simplement pas tokenisée (rien à
  substituer).

## Architecture

```
server/src/security/
  pseudonymisation.types.ts   Types partages (TokenMap, RoleIdentifiant,
                              ChampIdentifiantInput, AnonymizationResult)
  anonymizer.ts                anonymize() [pur] + redigerAvecPseudonymisation()
                                [orchestration : anonymise -> UN appel LLM ->
                                dé-tokenise -> log de tracabilite]
  deanonymizer.ts              deanonymize() [pur] + OrphanTokenError

server/tests/
  anonymizer.test.ts            9 tests
  deanonymizer.test.ts          7 tests
```

`anonymize()` et `deanonymize()` sont des fonctions **pures** (aucun accès
réseau/DB/fichier, aucun effet de bord) - testables isolément, conformément
à la bonne pratique demandée. `redigerAvecPseudonymisation()` (dans
`anonymizer.ts`, pour rester dans les 3 fichiers listés par le prompt) est
la seule fonction impure du module : elle encapsule le point d'insertion
complet (anonymise → appelle `redact` **une seule fois** → dé-tokénise →
journalise) et c'est elle que chaque branche concernée de `webActions.ts`
appelle, remplaçant l'ancien `await llm.redact(SYSTEM_PROMPT, buildXxx(...))`
par `await redigerAvecPseudonymisation({ champsIdentifiants, promptTexte:
buildXxx(...), redact: (p) => llm.redact(SYSTEM_PROMPT, p), typeActionLog })`.

Le module reste **agnostique du provider LLM** : `redact` est une fonction
injectée par l'appelant (`webActions.ts`), jamais un import direct vers
`services/llm/anthropic.ts`/`gemini.ts`/`groq.ts`.

## Fail-safe : token orphelin détecté

`deanonymize()` remplace chaque token connu, puis scanne le résultat avec
une regex couvrant tous les préfixes de rôle (`PARTIE|JUGE|GREFFIER|
HUISSIER|ADRESSE|IDENTIFIANT|TELEPHONE|EMAIL`), **insensible à la casse**
(si le LLM rend un token dans une casse différente de celle fournie, il est
quand même détecté comme orphelin plutôt que de passer inaperçu). Si un
token orphelin subsiste, `OrphanTokenError` est levée - jamais rattrapée
dans `anonymizer.ts`/`deanonymizer.ts`, elle remonte jusqu'au `catch` de
`webActions.ts`.

Ce `catch` (Lot 5, ajouté au `catch` générique déjà existant de la route) :
1. Journalise l'anomalie (type d'acte, horodatage) - **jamais** le contenu
   du prompt ni les valeurs réelles.
2. Résout/crée le dossier (mêmes `numero_dossier`/`nom_affaire`/`nom_client`
   que la tentative), puis crée une ligne `Action` avec `statut:
   "echec_generation"` et `contenuGenere: null` - pour que le cabinet
   retrouve la tentative dans son historique plutôt qu'elle ne disparaisse
   silencieusement.
3. Répond `422` avec exactement `"Anomalie de sécurité détectée lors de la
   génération — document non produit."` - aucun jargon technique
   ("token") côté utilisateur.

**Aucun retry automatique** : `redigerAvecPseudonymisation()` appelle
`redact` exactement une fois: il n'existe aucune boucle, aucun mécanisme de
nouvelle tentative dans ce module ni dans le `catch` de `webActions.ts`.
Seul un nouveau clic explicite de l'utilisateur sur "Générer" déclenche un
nouvel appel HTTP, donc un nouvel appel LLM.

## Ce qui a été réellement testé

### Tests unitaires (`npm test`, vitest) - 16/16 sur ce lot (56/56 au total, projet entier)

- Tokenisation simple (démandeur/défendeur → `PARTIE_A`/`PARTIE_B`, jamais
  les vrais noms dans le prompt).
- Rôles à suffixe numérique (`JUGE_1`, `GREFFIER_1`, `ADRESSE_1`).
- Stabilité : même valeur répétée plusieurs fois → même token partout ;
  même valeur sous deux champs différents → un seul token, dédupliqué.
- Parties multiples : 3 valeurs distinctes sous le rôle `PARTIE` → 3 tokens
  distincts et stables (`PARTIE_A`/`B`/`C`).
- Champs vides/absents (`""`, `undefined`, `null`, espaces) → ignorés
  silencieusement.
- Accents, apostrophes, tirets cadratins (`N'Da Amétépé Kokou d'Almeida`,
  `Résidence Aïcha — Bénin`) → tokenisés/restitués correctement.
- Non-mutilation : une valeur courte contenue dans une valeur longue
  (`"Jean"` dans `"Jean Dupont"`) ne corrompt pas le remplacement.
- Dé-tokenisation complète, y compris round-trip
  `anonymize → deanonymize` bit-à-bit identique au texte original.
- Détection de token orphelin (token non fourni, casse différente) → lève
  `OrphanTokenError`, sans jamais exposer la valeur réelle dans le message
  d'erreur.
- Collision de préfixes (`JUGE_1` substring de `JUGE_10`) → ordre de
  remplacement correct (les plus longs d'abord), aucune corruption.

### Test end-to-end réel (script créé pour cette vérification, exécuté, puis **supprimé** - non commis)

Contre une **vraie instance PostgreSQL** (cluster jetable, même approche que
les lots précédents) et le **vrai serveur Express** (`app.listen(0)`),
avec une vraie session authentifiée (JWT signé via `signAuthToken`), en
interceptant `global.fetch` **uniquement** pour les appels vers
`api.groq.com` (le reste du trafic - y compris les requêtes du test vers le
serveur local - passe par le vrai `fetch`) :

```
=== 1) Generation reussie : aucune donnee reelle envoyee au LLM ===
OK : le payload sortant vers le LLM ne contient pas le nom reel, contient PARTIE_A
OK : document final en base contient le vrai nom, aucun token visible, donneesPseudonymisees=true

=== 2) Token orphelin (hallucination LLM) : echec propre, un seul appel, rien persiste ===
OK : 422 avec message clair, 1 appel LLM (aucun retry)
OK : Action.statut = echec_generation, contenuGenere = null
```

Génération réelle via `POST /api/actions/web` (`mise_en_demeure`,
destinataire fictif `"Jean Kokou Dupont-N'Da"`) :
- Le **payload HTTP effectivement intercepté** envoyé à l'API Groq a été
  inspecté directement (pas une supposition sur le code) : il ne contient
  **à aucun endroit** la chaîne `"Jean Kokou Dupont-N'Da"`, et contient bien
  `"PARTIE_A"`.
- L'`Action` créée en base (relue via Prisma, donc après passage par le
  chiffrement au repos du Lot 2bis - confirmé fonctionner de façon
  transparente avec ce lot) a `donneesPseudonymisees: true` et
  `contenuGenere` contenant le **vrai** nom, sans aucun token visible.
- En simulant une réponse LLM contenant un token jamais fourni
  (`JUGE_1`, hallucination), la requête a échoué avec **exactement un seul**
  appel réseau intercepté vers Groq (compteur vérifié), une réponse `422`
  avec le message attendu mot pour mot, et l'`Action` tracée en base avec
  `statut = "echec_generation"` et `contenuGenere = null`.

Couvre directement les critères d'acceptation du prompt : aucune donnée
réelle dans le payload sortant (vérifié par interception réelle, pas
déduit), document final avec les vraies valeurs, `donneesPseudonymisees`
correctement positionné, échec propre et non-persistance sur token
orphelin, absence de retry automatique (compteur d'appels), et confirmation
que `documentExport.ts`/`documentFormalisme.ts` n'ont subi aucune
modification (`git status`).

## Non testé dans cet environnement

- **Qualité rédactionnelle réelle du LLM avec des tokens** (test de
  non-régression #7 du prompt) : aucune clé API LLM réelle
  (Anthropic/Gemini/Groq) n'est configurée dans cet environnement de
  développement - le test end-to-end ci-dessus utilise une réponse LLM
  *scriptée* (pas un vrai modèle), ce qui valide le mécanisme de
  substitution mais ne permet pas de juger si un vrai modèle rédige aussi
  bien un texte contenant `PARTIE_A`/`JUGE_1` qu'un texte avec les vrais
  noms. Recommandation : générer quelques actes réels de chaque type
  concerné (notes, mise en demeure, plainte, contrat, notification,
  requête, projet d'ordonnance) avec une vraie clé API avant mise en
  production, et comparer subjectivement à des générations antérieures à ce
  lot.
- Aucun flag de désactivation n'a été ajouté (le prompt le rendait
  conditionnel - "si un flag existe") : ce lot ne modifiant que des points
  d'insertion précis et n'étant pas activable/désactivable par
  configuration, il n'y avait pas de flag existant à réutiliser et créer un
  nouveau mécanisme d'activation/désactivation aurait dépassé le périmètre
  demandé (3 fichiers + 2 points d'insertion par branche concernée).

## Limite à communiquer au client (important)

Ce module protège l'**identité directe** : les champs structurés
explicitement identifiants (nom, destinataire, informations de partie à un
contrat) ne partent jamais en clair vers le LLM.

Il **ne protège pas** contre la **ré-identification indirecte** : le texte
narratif libre saisi par l'avocat (contexte, axes d'argumentation, faits)
**part sans modification** vers le LLM, et peut contenir des détails
permettant de deviner l'identité des parties même sans jamais citer leur
nom (une adresse précise, une profession rare, une combinaison de dates et
de circonstances propres à une seule affaire connue localement...). Ce
choix est **délibéré** et documenté dès le prompt de ce lot : la détection
heuristique de texte libre (NER/NLP) est explicitement hors périmètre
("trop peu fiable" à ce stade). **À communiquer clairement au cabinet** :
la pseudonymisation réduit le risque, elle ne l'élimine pas pour un lecteur
qui recouperait le texte avec une connaissance du dossier ou du contexte
local.

## Fichiers livrés

- `server/src/security/anonymizer.ts` (nouveau)
- `server/src/security/deanonymizer.ts` (nouveau)
- `server/src/security/pseudonymisation.types.ts` (nouveau)
- `server/src/routes/webActions.ts` (modifié - 7 branches + gestion
  d'erreur fail-safe, aucune autre logique touchée)
- `server/prisma/schema.prisma` (modifié - `donneesPseudonymisees` sur
  `Action`, `echec_generation` sur `StatutAction`)
- `server/prisma/migrations/20260802020000_pseudonymisation/migration.sql`
  (nouveau)
- `server/prisma/portable-init.sql` (regénéré)
- `server/tests/anonymizer.test.ts`, `server/tests/deanonymizer.test.ts`
  (nouveaux, 16 tests)
- `README-LOT5.md` (ce fichier)
