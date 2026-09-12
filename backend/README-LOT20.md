# Lot 20 — Gestion des courriers

Registre du courrier **physique/officiel** du cabinet (convocations,
significations, correspondances papier scannées ou reçues) — distinct de la
**Boîte de réception assistée** (Lot 16, qui traite les e-mails). Deux
registres numérotés séparément (entrants/sortants), un cycle de statut pour
les entrants, et une intégration avec les modules déjà en place (Documents,
Délais, Actions, Calendrier, Journal d'audit) — sans jamais dupliquer leur
logique.

## Principe directeur

Un seul champ est obligatoire à la création : **l'objet**. Tout le reste
(nature, expéditeur/destinataire, dossier, observations...) est optionnel et
se complète à tout moment depuis la fiche ("Compléter la fiche"), sans jamais
bloquer l'enregistrement d'un courrier "incomplet".

## Nature du courrier — correspondance avec les cas d'usage

Liste fermée (pas de saisie libre), pour garder les filtres/statistiques
fiables :

| Nature | Cas d'usage typique |
|---|---|
| Correspondance | Échange courant, sans caractère officiel particulier |
| Convocation | Convocation à une audience, un rendez-vous administratif... |
| Assignation | Acte introductif d'instance reçu ou délivré |
| Signification | Signification d'huissier (jugement, acte de procédure) |
| Mise en demeure | Mise en demeure reçue ou envoyée |
| Courrier client | Correspondance directe avec un client |
| Courrier de juridiction | Courrier émanant d'un tribunal/greffe |
| Courrier de confrère | Correspondance avec un autre avocat |
| Courrier administratif | Administration, organismes publics |
| Autre | Tout ce qui ne rentre pas dans les cas ci-dessus |

## Numérotation

Format `ARR-AAAA-NNNN` (entrants) / `DEP-AAAA-NNNN` (sortants), deux
séquences totalement indépendantes, réinitialisées chaque année civile
(`sequences_courrier`, une ligne par `(cabinet, année, sens)`).

Générée par un **seul** `INSERT ... ON CONFLICT (cabinet_id, annee, sens) DO
UPDATE SET dernier_numero = dernier_numero + 1 RETURNING dernier_numero`
(voir `services/courriers/numerotation.ts`) — jamais un "lire le max puis
écrire max+1" (c'est exactement le bug réel corrigé sur la numérotation des
factures, `routes/factures.ts`, `genererNumero` : un `SELECT` suivi d'un
`INSERT`/`UPDATE` séparé laisse une fenêtre où deux requêtes concurrentes
lisent la même valeur). Postgres verrouille implicitement la ligne cible de
l'upsert le temps de la transaction : deux créations simultanées pour le
même `(cabinet, année, sens)` sont sérialisées par la base elle-même, sans
advisory lock ni transaction `SERIALIZABLE` applicative.

## Cycle de statut (courrier entrant)

`Reçu → À affecter → Affecté → En traitement → Traité → Classé`

- Statut initial toujours `Reçu`, automatique — jamais un choix à la création.
- Chaque transition est horodatée et journalisée (voir plus bas).
- Les transitions autorisées sont définies dans `TRANSITIONS_ENTRANT`
  (`courrierService.ts`) — un retour en arrière est refusé (409).

Un courrier **sortant** suit un cycle plus simple : `Brouillon → Envoyé →
Classé` (pas d'affectation, déjà rédigé par quelqu'un).

## Réutilisation des briques existantes (jamais dupliquées)

- **Stockage/chiffrement** : `services/stockageDocuments.ts` (Lot 15),
  inchangé — mêmes fonctions `enregistrerFichier`/`lireFichier`/
  `supprimerFichier`, même chiffrement AES-256-GCM.
- **OCR** : `jobs/traitementOcr.ts` (Lot 17), inchangé — même
  `enqueuerTraitementOcr`, mêmes statuts `OcrResultat`.
- **Délais** : `services/delais.ts` (`computeDeadline`) et
  `services/evenementSync.ts` (`syncEvenementDepuisDelaiCalcul`), inchangés —
  un délai créé depuis un courrier est un `DelaiCalcul` standard, simplement
  rattaché via `courrierEntrantId` (référence croisée), visible à l'identique
  dans le module Délais et le Calendrier.
- **Journal d'audit** : `services/audit.ts`, étendu de façon additive
  (`logAuditCourrier`, même table `audit_logs`) — voir ci-dessous.
- **Actions** (`webActions.ts`) : **jamais modifié**. Voir "Créer une action"
  ci-dessous pour le choix retenu.

### Numérisation d'un courrier SANS dossier encore attaché

`DocumentDossier.dossierId` est obligatoire — impossible d'y stocker un scan
tant qu'aucun dossier n'est choisi, ce qui contredirait le principe "un seul
champ obligatoire à la création". Solution retenue : une piece est stockée
dans une table intermédiaire dédiée, `CourrierPieceJointe`, en réutilisant
**intégralement** les mêmes fonctions de `stockageDocuments.ts` — simplement
avec l'id du **courrier** comme clé de sous-dossier plutôt que l'id d'un vrai
`Dossier` (ces fonctions ne vérifient jamais que leur paramètre correspond à
un `Dossier` réel, elles s'en servent uniquement comme nom de répertoire).

Dès qu'un dossier est attaché au courrier (à la création ou plus tard via
"Compléter la fiche"), chaque pièce en attente est **migrée** vers un vrai
`DocumentDossier` (`source="courrier"`, nouvelle colonne
`courrierEntrantId`/`courrierSortantId`) et déclenche l'OCR existant, exactement
comme si elle avait été déposée directement sur un courrier déjà rattaché
(`courrierService.migrerPiecesJointesVersDossier`). Conséquence assumée : la
recherche plein texte OCR n'est disponible qu'une fois le dossier attaché —
documenté ici plutôt que de contourner l'invariant `DocumentDossier.dossierId
NOT NULL`.

### Journal d'audit — extension additive

`AuditLog.actionId` devient **facultatif** (`DROP NOT NULL`, migration
additive — aucune ligne existante affectée) et deux colonnes optionnelles
sont ajoutées : `courrierEntrantId`, `courrierSortantId`. Chaque ligne
renseigne **exactement un** des trois liens, jamais plusieurs ni aucun. La
page "Journal d'audit" existante (`routes/auditLogs.ts`, `routes/admin.ts`)
reste strictement celle des `Action` : ses requêtes filtrent déjà sur des
champs de la relation `action`, ce qui exclut implicitement les lignes
courrier — un simple assert de non-nullité (`log.action!`) suffit côté
TypeScript, sans changement de comportement.

### "Créer une action" depuis un courrier

`webActions.ts` (génération IA, formalisme, pseudonymisation...) reste
**totalement inchangé**. Le bouton "Créer une action" de la fiche courrier
ouvre "Nouvelle action" dans un nouvel onglet (dossier pré-rempli), puis
propose de **lier après coup** l'action fraîchement créée — ou une action
déjà existante sur ce dossier — via un nouvel endpoint dédié,
`POST /api/courriers-entrants/:id/lier-action`, qui se contente de poser la
référence `Action.courrierEntrantId` sur une ligne déjà créée par le flux
habituel. Aucune ligne de `webActions.ts` n'est modifiée.

### "Répondre à un courrier"

Contrairement à "Créer une action", répondre produit un vrai
`CourrierSortant` (pas une `Action`) : `POST /api/courriers-sortants` accepte
un `reponseAId` optionnel, pointant vers le `CourrierEntrant` d'origine — le
chaînage est donc visible des deux côtés (`CourrierEntrant.reponses[]` /
`CourrierSortant.reponseA`).

### Notification d'affectation

Aucun mécanisme de notification in-app générique n'existe ailleurs dans
Aurore (vérifié) — seul un motif ponctuel similaire existe pour la veille
juridique (`routes/veilleJuridiqueNotification.ts`), propre à un seul digest.
Implémentation minimale et cohérente avec ce précédent : un simple compteur
interrogé par polling (`GET /api/courriers-entrants/notifications`), sans
nouvelle table — le badge disparaît de lui-même dès que l'utilisateur fait
avancer le statut du courrier qui lui est affecté. Documentée ici comme
**nouvelle brique**, comme demandé quand aucun mécanisme existant n'est
réutilisable tel quel.

## Compteurs du tableau de bord

`courrierService.compterCourriers()` n'exécute que des requêtes `COUNT`
agrégées (jamais un chargement complet des lignes en mémoire) — reste rapide
même si le volume de courriers grossit. Widget indépendant sur
`tableau-de-bord.html` (son propre appel API, jamais mêlé à `/api/stats` ni
à `loadStats()`), pour ne prendre aucun risque sur le tableau de bord
existant.

## Permissions

Nouveau module payant `"courriers"` dans `config/modulesDisponibles.ts` —
même mécanisme que `"facturation"`/`"delais"` (`requireModule`), gérable côté
plateforme (`admin-plateforme.html`) et par cabinet (`collaborateurs.html`).

## Fichiers ajoutés/modifiés

- `prisma/schema.prisma` + `prisma/migrations/20260912000000_lot20_gestion_courriers/`
  — migration purement additive (nouvelles tables/colonnes/enums,
  `AuditLog.actionId` devient facultatif, aucune donnée existante affectée).
- `src/services/courriers/numerotation.ts`, `src/services/courriers/courrierService.ts`
- `src/services/audit.ts` — ajout de `logAuditCourrier` (existant inchangé)
- `src/routes/courriers.ts`, monté dans `src/app.ts`
- `src/config/modulesDisponibles.ts` — nouvelle clé `"courriers"`
- `src/routes/auditLogs.ts`, `src/routes/admin.ts` — assert de non-nullité
  sur `log.action` (conséquence mécanique de `actionId` devenu facultatif,
  comportement inchangé pour ces deux pages)
- `public/courriers.html`, `public/courrier-fiche.html`, `public/js/courrier-fiche.js`
- `public/js/layout.js` — entrée de navigation "Courriers"
- `public/tableau-de-bord.html` — widget compteurs (bloc indépendant)
- `public/admin-plateforme.html`, `public/collaborateurs.html` — module
  "Gestion des courriers" dans les listes de modules gérables
- `public/style.css` — badges de statut dédiés (`badge-courrier-*`)
- `tests/e2e/courriers.test.ts`

## Limites connues / non couvert dans ce lot

- La **recherche plein texte** sur le contenu OCR d'un courrier réutilise
  l'écran de recherche OCR existant (`routes/ocr.ts`) — pas de barre de
  recherche unifiée "objet + contenu OCR" dans `courriers.html` (filtre texte
  actuel : numéro/objet/expéditeur-destinataire uniquement).
- Pas de test automatisé de navigateur pour le frontend (`courriers.html`,
  `courrier-fiche.html`) — vérifié manuellement via lecture de code et
  cohérence des endpoints, mais pas exécuté dans un vrai navigateur.
