# Lot 10 : remarques de révision (avocat/titulaire → collaborateur)

Ajoute un moyen, pour l'avocat responsable, de laisser une remarque
("corrige ce passage", "attention à ce point") directement sur un document
en attente de validation, plutôt que par un canal externe (WhatsApp, appel,
papier annoté). Nouveau statut `revision_demandee` inséré dans le cycle
existant sur `Action` :

```
brouillon
   ↓ (génération réussie)
en_attente_validation
   ↓                                    ↓
valide                          revision_demandee  (avocat/titulaire ajoute
   ↓                                    ↓            ≥ 1 remarque "ouverte")
envoye                          (collaborateur corrige, résout les
                                  remarques, "Renvoyer pour validation")
```

## Portée V1 (assumée, comme spécifié)

Les remarques sont **générales sur le document**, jamais ancrées sur un
passage de texte précis - pas de sélection façon Google Docs. Un ancrage se
casse dès que le texte autour bouge dans un éditeur Markdown en texte libre ;
cette fragilité a été jugée non justifiée pour une V1. Une V2 avec ancrage
reste envisageable si l'usage réel le montre nécessaire.

Les commentaires ne modifient **jamais** `contenuGenere` eux-mêmes : c'est
le collaborateur qui édite manuellement via l'éditeur existant
(`PATCH /api/actions/:id/contenu`, inchangé) - les remarques ne sont qu'un
aide-mémoire.

## Règle de transition (précise)

- **`en_attente_validation` → `revision_demandee`** : automatique, dès
  qu'un avocat/titulaire crée un commentaire sur un document dans l'un de
  ces deux statuts (une remarque supplémentaire pendant que le document est
  déjà en révision ne change rien de plus).
- **`revision_demandee` → `en_attente_validation`** : **jamais automatique**,
  même une fois la dernière remarque résolue - seule l'action explicite
  `POST /api/actions/:id/renvoyer-validation` déclenche le retour, et elle
  est bloquée (`409`) tant qu'il reste au moins une remarque `"ouvert"`.
  Choix délibéré : laisse le collaborateur traiter tous les points avant de
  renvoyer, plutôt qu'un renvoi prématuré dès la première correction.
- **Validation bloquée si remarques ouvertes** : `POST /api/actions/:id/valider`
  (route existante, `server/src/routes/actionsCallback.ts`) refuse
  désormais (`409`) si `CommentaireRevision` en statut `"ouvert"` existe
  pour ce document - vérifié côté backend, pas seulement désactivé côté UI.

## Permissions

- **Créer une remarque** : refusé à un `collaborateur` (`403`). Autorisé à
  tout avocat/titulaire du cabinet - même règle d'accès que la route
  `/valider` déjà existante (accès par appartenance au cabinet, pas de
  filtrage par avocat responsable du dossier : dans cette base de code,
  l'accès en lecture/action à un document est déjà ouvert à tout membre du
  cabinet via la "Vue cabinet" - `getAccessibleAvocatIds` ne sert qu'au
  filtrage des tableaux de bord/listes "mes dossiers" vs "tout le cabinet",
  jamais à l'autorisation d'une action individuelle sur une `Action`).
- **Résoudre une remarque** : réservé au collaborateur qui a rédigé le
  document (`Action.createdBy`) ou à l'auteur de la remarque elle-même -
  vérifié côté backend (`403` sinon), conformément à la spec.
- **Renvoyer pour validation** : n'importe quel membre authentifié du
  cabinet ayant accès au document (même règle que ci-dessus) ; la garde
  utile est le blocage sur remarques ouvertes, pas un rôle précis - dans la
  pratique, seul le collaborateur voit le bouton actif côté frontend.

## Notifications (V1)

Option retenue explicitement avec vous : **badge/compteur au tableau de
bord**, pas de notification push ni d'email. `GET /api/stats` renvoie
désormais `revisionsDemandees` (même périmètre d'accès que les autres
compteurs du tableau de bord : un collaborateur voit celles de son avocat
responsable, un avocat les siennes, le titulaire tout le cabinet par
défaut), affiché dans une nouvelle carte "Révisions demandées" sur
`tableau-de-bord.html`. L'option email (Brevo) reste documentée dans la
spec d'origine, à activer plus tard si l'usage réel le justifie.

## Module désactivable par cabinet

Toutes les routes de ce lot passent par `requireModule("revision")`
(mécanisme cabinet déjà existant, `middleware/roles.ts`) - la clé `revision`
a été ajoutée à la liste `MODULES` de `admin-plateforme.html`, activable/
désactivable par la plateforme comme les autres modules (`facturation`,
`jurisprudence`...). Prépare le terrain pour le Lot 9 (permissions
granulaires par utilisateur), qui n'existe pas encore à ce jour.

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié - `revision_demandee` sur
  `StatutAction`, nouveau modèle `CommentaireRevision`, relations sur
  `Action`/`User`)
- `backend/prisma/migrations/20260807000000_commentaires_revision/migration.sql`
  (nouveau)
- `backend/prisma/portable-init.sql` (régénéré via `npm run prisma:portable-sql`)
- `backend/src/routes/commentairesRevision.ts` (nouveau - les 4 routes)
- `backend/src/routes/actionsCallback.ts` (modifié - garde sur `/valider`
  uniquement, aucune autre logique touchée)
- `backend/src/routes/dossiers.ts` (modifié - `GET /api/dossiers/:id`
  inclut désormais `commentaires` par action)
- `backend/src/routes/stats.ts` (modifié - `revisionsDemandees`)
- `backend/src/app.ts` (modifié - enregistrement du routeur)
- `backend/public/dossier.html` (modifié - panneau "Remarques", badge de
  statut, boutons Ajouter/Résoudre/Renvoyer pour validation)
- `backend/public/tableau-de-bord.html` (modifié - carte "Révisions
  demandées")
- `backend/public/admin-plateforme.html` (modifié - clé de module `revision`)
- `backend/public/style.css` (modifié - badge `revision_demandee`, styles
  du panneau Remarques)
- `backend/tests/e2e/commentaires-revision.test.ts` (nouveau, 10 tests)
- `backend/tests/e2e/helpers/testApp.ts` (modifié - `mintAuthCookie` accepte
  désormais un rôle, rétrocompatible - défaut `"titulaire"` inchangé)
- `README-LOT10.md` (ce fichier)

**Non modifiés** (vérifié) : `documentExport.ts`, `documentFormalisme.ts`,
la logique de génération IA/pseudonymisation dans `webActions.ts`.

## Ce qui a été réellement testé

`backend/tests/e2e/commentaires-revision.test.ts` (10 tests, contre une
vraie instance PostgreSQL jetable et le vrai serveur Express, licence
court-circuitée via `LICENCE_BYPASS` - non pertinente pour ce lot, déjà
couverte par `full-workflow.test.ts`) :

1. Un collaborateur ne peut pas créer de remarque (`403`).
2. Un avocat/titulaire peut en créer une ; le document passe bien à
   `revision_demandee`.
3. `GET` liste correctement la remarque créée.
4. `/valider` est bloqué (`409`) tant que la remarque reste ouverte.
5. `/renvoyer-validation` est bloqué (`409`) tant que la remarque reste
   ouverte.
6. Un avocat n'ayant ni rédigé le document ni écrit la remarque ne peut pas
   la résoudre (`403`).
7. Le collaborateur qui a rédigé le document peut la résoudre.
8. `/renvoyer-validation` réussit une fois la remarque résolue → retour à
   `en_attente_validation`.
9. `/valider` réussit ensuite → `valide`.
10. La remarque résolue reste en base (jamais supprimée) - traçabilité.

Suite complète du projet rejouée après ce lot : **82 tests passés**, 4
skippés (licence, non concernée), 0 échec imputable à ce lot -
`tsc --noEmit` propre. (Un échec ponctuel de `licence-expiry-flow.test.ts`
observé lors d'une exécution parallèle de 4 suites e2e - contention
Postgres sur cette machine - a été confirmé non lié à ce lot en le rejouant
seul : passe systématiquement.)

## Non testé dans cet environnement

- **Rendu visuel réel** du panneau "Remarques" dans un navigateur (pas
  d'environnement UI disponible ici) - la logique JS (affichage
  conditionnel selon statut/rôle, formulaire d'ajout, désactivation du
  bouton "Renvoyer pour validation") a été relue attentivement mais pas
  cliquée dans un vrai navigateur. À vérifier manuellement avant mise en
  production : création d'une remarque, résolution, renvoi, validation,
  depuis l'écran `dossier.html`.
- **Option notification email (Brevo)** : non implémentée dans cette V1
  (option "badge simple" retenue avec vous) - le câblage Brevo existant
  (`services/mailer.ts`, utilisé pour l'envoi de documents) n'a pas été
  réutilisé ici.
