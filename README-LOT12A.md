# Lot 12a : modèle Événement unifié + calendrier mensuel filtrable

Ajoute une couche d'affichage et d'organisation par-dessus les deux systèmes
existants (`RoleAudience`, `DelaiCalcul`), **sans toucher au moteur de
calcul des délais** ni à la logique métier existante. Vérifié : aucune
modification de `services/delais.ts` (`computeDeadline`), de la saisie du
rôle greffe, ni du "Rôle de la semaine" existant.

## Le modèle `Evenement`

```
Evenement
  - id, cabinetId, dossierId (nullable)
  - type       : audience | rdv | appel | tache | echeance_procedure | autre
  - source     : manuel | role_audience | delai_calcule | sync_google | sync_caldav
  - titre, description, lieu
  - dateDebut, dateFin (nullable), touteLaJournee
  - createdById, createdAt, updatedAt
  - roleAudienceId (unique, nullable) -> RoleAudience
  - delaiCalculId  (unique, nullable) -> DelaiCalcul

EvenementAssigne (table de liaison)
  - evenementId, userId
```

- `type` est une énumération stricte Prisma (jamais du texte libre) — permet
  un filtrage fiable côté API et frontend.
- `roleAudienceId`/`delaiCalculId` sont des clés étrangères **uniques**
  (au plus un `Evenement` par `RoleAudience`/`DelaiCalcul` — relation 1:1),
  utilisées par `evenementSync.ts` pour retrouver/mettre à jour/supprimer
  l'`Evenement` correspondant sans recherche fragile par contenu.
- **Champs anticipant le Lot 12b** : `source` inclut déjà `sync_google` et
  `sync_caldav` (non utilisés dans ce lot) — évite une migration
  supplémentaire lors de l'intégration calendrier externe. `EvenementAssigne`
  (table de liaison explicite, pas une relation many-to-many implicite) est
  déjà prêt pour un futur filtrage/synchronisation par personne (Lot 16).
- **Ajout par rapport à la spec initiale** : la valeur `role_audience` de
  `source` (la spec n'en listait que 4 : `manuel`, `delai_calcule`,
  `sync_google`, `sync_caldav`) a été ajoutée — un événement généré depuis
  `RoleAudience` a évidemment besoin de sa propre origine, au même titre que
  `delai_calcule` pour `DelaiCalcul`. Décision assumée, documentée ici.

## Stratégie de migration douce depuis `RoleAudience`

**`RoleAudience` n'est ni supprimé ni modifié dans sa logique** - la saisie
du rôle greffe continue de fonctionner exactement comme avant. Un hook
**additif**, appelé *après* chaque point de création/modification/
suppression existant (jamais à l'intérieur de sa logique), tient à jour
l'`Evenement` correspondant :

| Point d'origine | Hook appelé après |
|---|---|
| `POST /api/role-audiences` | `syncEvenementDepuisRoleAudience()` |
| `PATCH /api/role-audiences/:id` | `syncEvenementDepuisRoleAudience()` |
| `DELETE /api/role-audiences/:id` | `supprimerEvenementDepuisRoleAudience()` |
| `POST /api/delais/calculer` | `syncEvenementDepuisDelaiCalcul()` |
| `DELETE /api/delais/:id` (**nouvelle route**, voir ci-dessous) | `supprimerEvenementDepuisDelaiCalcul()` |

**Résilience (contrainte explicite du prompt)** : chaque fonction de
`evenementSync.ts` encapsule son propre `try/catch` et **ne rejette
jamais** — une erreur (ex. DB temporairement indisponible) est journalisée
(`console.error`) et avalée, jamais propagée à l'appelant. La route qui
appelle le hook n'a donc pas besoin de son propre `try/catch` : la création/
modification/suppression du `RoleAudience`/`DelaiCalcul` d'origine reste
garantie de réussir même si la synchronisation échoue. Testé précisément au
niveau unitaire (`evenementSync.test.ts`, prisma mocké pour faire échouer
`evenement.upsert`/`deleteMany`) plutôt qu'en e2e : c'est le seul niveau où
on peut faire échouer *sélectivement* l'appel Prisma sous-jacent sans
perturber le reste du test.

**Aucun recalcul** : les hooks lisent uniquement `RoleAudience.dateAudience`
et `DelaiCalcul.dateLimite`, déjà calculés — zéro logique de délai dupliquée.

**Nouvelle route `DELETE /api/delais/:id`** : n'existait pas avant ce lot
(seules la création et l'historique existaient). Ajoutée car la contrainte
"la suppression d'un `DelaiCalcul` doit supprimer l'`Evenement` lié" n'avait
sinon aucun point d'ancrage. Additive, ne touche à aucune logique de calcul.

## API `evenements.ts`

- `GET /api/evenements?debut&fin&type&assigne&scope` — toujours borné à une
  période (`[debut, fin[`, mois en cours par défaut) : jamais un chargement
  complet du cabinet. `scope=mine|cabinet` suit exactement la même
  convention que `stats.ts`/`dossiers.ts` (`getAccessibleAvocatIds`).
- `GET /api/evenements?dossierId=...` — cas particulier "Agenda du dossier" :
  tous les événements liés, sans limite de période ni de scope (même règle
  d'accès que la fiche dossier elle-même, déjà vérifiée par
  `GET /api/dossiers/:id`).
- `POST /api/evenements` — création manuelle, **types `rdv`/`appel`/
  `tache`/`autre` uniquement** (rejeté par Zod pour `audience`/
  `echeance_procedure`, exclusivement générés par `evenementSync.ts`).
- `PATCH`/`DELETE /api/evenements/:id` — bloqués (`409`) sur un événement
  `source !== "manuel"`, avec message explicite renvoyant vers sa source
  (rôle de la semaine ou délais).

## Frontend

- `public/calendrier.html` + `public/js/calendrier.js` : implémentation
  **JS natif** (grille CSS pour la vue mois, colonnes pour semaine, listes
  pour jour/liste) — pas de librairie externe, cohérent avec le reste de
  l'app (aucune page n'en charge). Chips colorées par type, modale de détail
  (édition/suppression visibles seulement pour `source === "manuel"`),
  modale de création/édition (type, titre, description, dates, lieu,
  dossier lié via datalist, assignés via cases à cocher).
- Onglet **"Agenda du dossier"** : nouvelle section sur `dossier.html`
  (même position/style que la section "Délais" déjà existante — le reste de
  la page utilise des sections empilées, pas un vrai composant à onglets ;
  choix délibéré de suivre la convention déjà en place plutôt que
  d'introduire un nouveau motif d'interface). Chaque ligne renvoie vers
  `/calendrier.html?date=...&vue=jour`, lu au chargement pour centrer le
  calendrier sur la bonne date.
- `layout.js` : nouvelle entrée "Calendrier" (`/calendrier.html`), distincte
  de "Calendrier Audiences" (`/role-semaine.html`) déjà existante — les deux
  coexistent : la première est la vue unifiée de ce lot, la seconde reste
  l'outil de préparation dédié aux audiences (statuts à préparer/prêt/
  traité), non remplacé.

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié - `Evenement`, `EvenementAssigne`,
  enums `TypeEvenement`/`SourceEvenement`, relations)
- `backend/prisma/migrations/20260807020000_calendrier_unifie/migration.sql`
  (nouveau)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/services/evenementSync.ts` (nouveau)
- `backend/src/routes/evenements.ts` (nouveau)
- `backend/src/routes/roleAudiences.ts` (modifié - hooks sur create/update/delete)
- `backend/src/routes/delais.ts` (modifié - hook sur create, nouvelle route delete)
- `backend/src/app.ts` (modifié - enregistrement du routeur)
- `backend/public/calendrier.html`, `backend/public/js/calendrier.js` (nouveaux)
- `backend/public/dossier.html` (modifié - section "Agenda du dossier")
- `backend/public/js/layout.js` (modifié - entrée de navigation)
- `backend/public/style.css` (modifié - styles calendrier + badges par type)
- `backend/src/services/__tests__/evenementSync.test.ts` (nouveau, 5 tests)
- `backend/tests/e2e/calendrier-unifie.test.ts` (nouveau, 9 tests)
- `README-LOT12A.md` (ce fichier)

**Non modifiés** (vérifié) : `services/delais.ts` (moteur de calcul),
`roleSemaineExport.ts`, toute la logique de génération de documents.

## Ce qui a été réellement testé

Suite complète du projet rejouée après ce lot : **121/121 tests passés**
(hors un échec ponctuel de `commentaires-revision.test.ts` en exécution
parallèle — contention Postgres sur cette machine, déjà documentée aux
Lots 10/11 ; confirmé non lié à ce lot en le rejouant seul : passe
systématiquement), `tsc --noEmit` propre, `eslint` sans nouvelle erreur (3
erreurs préexistantes, hors fichiers de ce lot).

`calendrier-unifie.test.ts` (9 tests, PostgreSQL réel) : génération d'un
`Evenement type=audience` à la création d'un `RoleAudience`, re-synchro à la
modification, non-régression de `GET /api/role-audiences`, suppression
propagée ; génération d'un `Evenement type=echeance_procedure` à la création
d'un `DelaiCalcul`, visible via l'API "Agenda du dossier", suppression
propagée ; filtre par type et par collaborateur assigné ; rejet de la
création manuelle d'un type réservé (`audience`) ; cohérence d'un même
événement retrouvé à la fois par une fenêtre "semaine" et "mois".

`evenementSync.test.ts` (5 tests, unitaires, Prisma mocké) : les 4
fonctions de synchronisation ne rejettent jamais même si l'appel Prisma
sous-jacent échoue ; ne font rien silencieusement si l'enregistrement
source n'existe déjà plus.

## Non testé dans cet environnement

- **Rendu visuel réel** du calendrier (grille mois, chips, modales) dans un
  navigateur - pas d'environnement UI disponible ici. La logique JS a été
  relue et syntaxiquement validée (`node --check`), pas cliquée. À vérifier
  manuellement avant mise en production : les 4 vues, la création/édition/
  suppression d'un événement manuel, le clic sur un jour en vue mois, le
  lien "Voir dans le calendrier" depuis l'Agenda du dossier.
- **Édition d'un événement manuel pour retirer son dossier lié ou sa date de
  fin** : la modale d'édition envoie `undefined` (pas `null`) quand ces
  champs sont laissés vides, ce que `PATCH /api/evenements/:id` interprète
  comme "inchangé" plutôt que "à effacer" - limitation mineure assumée pour
  cette V1 (l'API elle-même supporte `null` explicite, seul le formulaire ne
  l'expose pas encore).
