# Lot 14 : timer & feuilles de temps

Chronomètre persistant côté serveur, saisie manuelle en rattrapage, fiches
de temps agrégées (par collaborateur, par dossier, exportables en PDF), et
génération de facture directement à partir du temps enregistré. Ne touche à
aucune logique métier de facturation existante au-delà du point d'intégration
précisé (`POST /api/factures/depuis-temps`, insertion ciblée dans
`factures.ts`) ; `documentExport.ts`, `documentFormalisme.ts` et le pipeline
de génération d'actes ne sont pas modifiés.

## Modèle `SaisieTemps`

```
SaisieTemps
  - id, cabinetId, dossierId, actionId (optionnel), userId
  - source        : "chrono" | "manuel"
  - date          : jour calendaire auquel ce temps est rattaché
  - demarreA / arreteA : renseignés uniquement pour une saisie chronométrée
  - dureeMinutes  : toujours renseignée une fois la saisie terminée (null
                    tant qu'un chronomètre tourne)
  - description, facturable (bool)
  - tauxHoraireApplique : snapshot FCFA/heure au moment de la création
  - factureId     : renseigné une fois incluse dans une facture générée
```

`User.tauxHoraireDefaut` (Int, nullable) : **taux individuel**, pas un taux
unique par cabinet — décision tranchée conformément à la recommandation du
prompt ("un avocat senior facture plus qu'un collaborateur junior"). Réservé
à l'admin (`PATCH /api/users/:id/taux-horaire`, `requireAdmin`) : géré comme
une décision de gouvernance du cabinet, pas une auto-déclaration par
l'utilisateur lui-même — cohérent avec le reste des réglages RH déjà gérés
ainsi dans `collaborateurs.html` (accès, responsable, promotion admin).

## Chronomètre persistant

**Persistance réelle, pas seulement en mémoire navigateur** : `POST /api/saisies-temps/demarrer`
crée immédiatement la `SaisieTemps` (statut "en cours" = `demarreA` renseigné,
`arreteA` null) — c'est cet enregistrement, relu à chaque chargement de page
via `GET /api/saisies-temps/actif`, qui fait foi. `public/js/timer.js` ne
fait que : (1) relire cet état au chargement, (2) faire défiler
l'affichage localement via `setInterval` (purement visuel, recalculé
depuis `demarreA` à chaque tick) — un rafraîchissement de page, une
navigation, ou la fermeture de l'app ne perd jamais le temps déjà écoulé,
il est simplement recalculé à la prochaine ouverture.

**Un seul chronomètre actif à la fois** — tranché comme recommandé par le
prompt : **bloqué avec un message clair** (`409`, message identifiant le
dossier en cours), plutôt qu'un arrêt automatique du précédent, pour éviter
qu'un clic malencontreux ne fasse perdre silencieusement du temps déjà
comptabilisé sur le mauvais dossier. Vérification faite **côté application**
(requête avant création) plutôt qu'une contrainte SQL dédiée (index partiel
`WHERE arrete_a IS NULL`) : ce projet régénère `portable-init.sql`
intégralement depuis `schema.prisma` (voir tous les lots précédents) — un
index partiel non exprimable dans le DSL Prisma serait silencieusement perdu
à chaque régénération, un piège de maintenance à long terme jugé plus
coûteux que la fenêtre de course théorique (un même utilisateur cliquant
deux fois en quelques millisecondes), négligeable en pratique pour un outil
mono-utilisateur-par-session.

**Arrondi** : à la minute la plus proche (`arrondirMinutes()`,
`routes/saisiesTemps.ts`), appliqué **une seule fois**, au moment où le
chronomètre est arrêté — jamais recalculé ensuite, jamais par
`services/feuillesTemps.ts` (qui ne fait que sommer des `dureeMinutes` déjà
arrondies). Garantit qu'il n'y a jamais d'écart entre ce qui s'affiche et ce
qui est facturé.

**Avertissement chronomètre oublié** : purement visuel (`timer.js`), si le
temps écoulé dépasse 4h — signale sans jamais bloquer ni arrêter
automatiquement (contrainte explicite du prompt).

## Politique de taux horaire snapshotté

`tauxHoraireApplique` est copié depuis `User.tauxHoraireDefaut` **au moment
de la création** de chaque `SaisieTemps` (chronomètre démarré, ou saisie
manuelle créée) — jamais relu dynamiquement ensuite. Une modification
ultérieure du taux d'un utilisateur n'affecte donc **jamais** rétroactivement
une saisie déjà enregistrée (vérifié par test e2e : création → modification
du taux → relecture de la saisie d'origine → taux inchangé). Conséquence
directe pour l'agrégation (`services/feuillesTemps.ts`) : le montant total
d'une période ne peut **jamais** être calculé en multipliant une durée totale
par un taux unique — chaque saisie garde son propre taux, les montants sont
calculés saisie par saisie puis sommés (`calculerMontant()`).

## Facturable vs non facturable

`SaisieTemps.facturable` (défaut `true`) distingue une saisie facturable
(temps client) d'une saisie non facturable (recherche interne, formation).
Les deux types sont **toujours** inclus dans les agrégations de
`services/feuillesTemps.ts` (statistiques internes de charge de travail),
mais seules les saisies facturables sont proposées par
`POST /api/factures/depuis-temps` — vérifié par test e2e (une saisie non
facturable apparaît dans la feuille de temps agrégée, jamais dans le
montant d'une facture générée).

## "Facturer ce dossier" depuis le temps passé

`POST /api/factures/depuis-temps` (`routes/factures.ts`, insertion ciblée,
aucune autre route du fichier modifiée) :
1. Sélectionne les `SaisieTemps` du dossier : `facturable=true`,
   `dureeMinutes` renseignée (jamais un chronomètre encore actif),
   `factureId=null` (jamais déjà facturée).
2. Calcule le montant total en sommant `calculerMontant()` saisie par
   saisie (jamais un taux unique × durée totale — voir plus haut).
3. Construit une description groupée par collaborateur (durée + montant par
   personne).
4. Crée la `Facture` (même génération de numéro que le reste du module,
   `genererNumero()` inchangée) et, **dans la même transaction**, rattache
   (`factureId`) toutes les saisies incluses — dès cet instant, elles
   n'apparaissent plus comme disponibles pour une facturation ultérieure
   (vérifié par test e2e : un second appel sur le même dossier renvoie `400`
   "aucune saisie disponible").
5. Une saisie déjà facturée (`factureId` non nul) ne peut plus être modifiée
   ni supprimée (`409` explicite sur `PATCH`/`DELETE`).

Le lien existant "Facturer ce dossier" (`dossier.html`, vers
`factures.html?dossierId=...`, saisie manuelle libre) est **conservé tel
quel** — le nouveau bouton "Facturer le temps passé" (widget chronomètre)
est une action **distincte**, pour ne jamais créer d'ambiguïté entre les
deux flux de création de facture.

## Permissions

- Un utilisateur ne voit et ne modifie **que ses propres** `SaisieTemps`
  (`GET/PATCH/DELETE /api/saisies-temps*` sans `/equipe`, toujours filtré
  par `userId = req.auth.userId`).
- `GET /api/saisies-temps/equipe` et `GET /api/saisies-temps/feuille`
  (avec `userId` d'un tiers) : réservés aux avocats/titulaire, et
  seulement pour un collaborateur **directement supervisé**
  (`responsableId === auth.userId`) — même règle que
  `GET /api/dossiers?membre=` (`dossiers.ts`), déjà établie dans le projet.
  Le titulaire (admin) voit tout le cabinet. Un collaborateur qui tente
  d'accéder à `/equipe` est rejeté (`403`), quel que soit le paramètre.

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié - `SaisieTemps`, `User.tauxHoraireDefaut`, enum `SourceSaisieTemps`)
- `backend/prisma/migrations/20260807050000_saisies_temps/migration.sql` (nouveau)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/routes/saisiesTemps.ts` (nouveau)
- `backend/src/services/feuillesTemps.ts` (nouveau)
- `backend/src/routes/factures.ts` (modifié - `POST /api/factures/depuis-temps`, insertion ciblée)
- `backend/src/routes/users.ts` (modifié - `PATCH /api/users/:id/taux-horaire`, `tauxHoraireDefaut` exposé par `GET /api/users`)
- `backend/src/app.ts` (modifié - enregistrement du routeur)
- `backend/public/js/timer.js` (nouveau - widget chronomètre)
- `backend/public/dossier.html` (modifié - section "Temps passé")
- `backend/public/feuilles-temps.html`, `backend/public/js/feuilles-temps.js` (nouveaux)
- `backend/public/collaborateurs.html` (modifié - champ taux horaire par membre, admin uniquement)
- `backend/public/js/layout.js` (modifié - entrée de navigation)
- `backend/public/style.css` (modifié - styles du widget chronomètre)
- Tests : `src/services/__tests__/feuillesTemps.test.ts` (6 tests), `tests/e2e/saisies-temps.test.ts` (12 tests)
- `README-LOT14.md` (ce fichier)

**Non modifiés** (vérifié) : `documentExport.ts`, `documentFormalisme.ts`,
le pipeline de génération d'actes, toutes les routes `factures.ts`
existantes hors l'ajout ciblé.

## Ce qui a été réellement testé

Suite complète du projet rejouée : **203/203 tests passés**, `tsc --noEmit`
propre, `eslint` sans nouvelle erreur (3 erreurs préexistantes, hors
fichiers de ce lot).

`saisies-temps.test.ts` (12 tests, e2e, PostgreSQL réel) : démarrage d'un
chronomètre et persistance vérifiée par une requête entièrement nouvelle
(`GET /actif`, simulant fermeture/réouverture), blocage explicite d'un
second chronomètre avec le numéro du dossier en cours dans le message,
arrêt avec durée calculée, saisie manuelle indépendante du chronomètre,
snapshot du taux horaire (création → changement de taux → relecture →
taux d'origine inchangé), exclusion d'une saisie non facturable de la
facturation mais présence dans la feuille agrégée, génération de facture
correcte depuis le temps passé (montant exact, description détaillée),
non-double-comptage (les saisies facturées disparaissent de la
disponibilité), blocage de modification/suppression d'une saisie déjà
facturée, permissions (avocat non-superviseur rejeté, collaborateur
rejeté sur `/equipe`, saisie d'autrui introuvable en `404`), et accès
légitime du titulaire à la vue équipe.

`feuillesTemps.test.ts` (6 tests, unitaire) : calcul de montant
proportionnel (et `0` si aucun taux configuré), formatage compact des
durées, agrégation par collaborateur et par dossier (sommes facturable/non
facturable/montant correctes, tri alphabétique).

## Non testé dans cet environnement

- **Rendu visuel réel** du widget chronomètre (défilement de l'affichage,
  avertissement 4h) et de l'écran "Feuilles de temps" dans un navigateur -
  relu et syntaxiquement validé (`node --check`), pas cliqué.
- **Export PDF réel** ouvert dans un lecteur - `buildFeuilleTempsPdf()`
  suit exactement le même moteur `pdfkit` que `facturePdf.ts`/`roleSemaineExport.ts`,
  déjà éprouvé dans le projet, mais le fichier généré n'a pas été
  visuellement inspecté ici.
