# Audit préalable — Module RH Cabinet (lecture seule)

Audit effectué sur l'état réel du code (branche `rh-00-audit`, créée à partir
de l'état le plus récent du dépôt — inclut le module Notifications livré le
même jour). Toutes les informations ci-dessous proviennent d'une lecture
directe du code ; les cases non trouvées sont marquées **introuvable**.

## 1. Utilisateurs et équipe

**Modèle `User`** (`backend/prisma/schema.prisma:355` et suivants) : `id`,
`cabinetId` (357), `nom` (358), `email` unique (359), `motDePasseHash` (360),
`resetCodeHash`/`resetCodeExpiresAt` (364-365), `role UserRole @default(collaborateur)`
(366), `responsableId` (368, avocat responsable d'un collaborateur, null pour
un titulaire), `signatureUrl` (370), `partageSignatureActif` (373),
`accesTousDossiers` (376), `modulesDesactives String[] @default([])` (386,
clés de module retirées pour CET utilisateur précis), `recoitVeille` (389),
`veilleDerniereVue` (394), `actif` (~395).

**Enum `UserRole`** (`schema.prisma:17-27`) : `titulaire`, `avocat`,
`collaborateur`, `super_admin` (compte plateforme).

**Module "Équipe" (front)** : entrée de nav `backend/public/js/layout.js:41-49`
(label "Équipe", `roles: ["titulaire","avocat"]`), écran unique
`backend/public/collaborateurs.html` (filtré par `?filtre=avocat|collaborateur`).

**Routes `backend/src/routes/users.ts`** (liste des endpoints avec ligne du
handler) : `GET /api/users/annuaire` (56), `GET /api/users` (65),
`POST /api/users` (90), `POST /api/users/avocats` (131),
`POST /api/users/access-grants` (174), `DELETE .../access-grants` (205),
`PATCH .../access-grants` (224, 260), `PATCH /api/users/:id/modules` (298),
`PATCH /api/users/:id/taux-horaire` (334, 361),
`PATCH /api/users/me/veille` (404), `PATCH /api/users/me/onglets` (424),
`PATCH /api/users/:id/actif` (447), `PATCH /api/users/:id/promouvoir-admin`
(475), `PATCH /api/users/:id/nom` (504), `DELETE /api/users/:id` (535),
`PATCH /api/users/me` (568).

**Middleware `requireModule`** (`backend/src/middleware/roles.ts:42-75`) :
deux niveaux — (1) `Cabinet.modulesDesactives` (licence plateforme,
priorité absolue, lignes 51-58), (2) `User.modulesDesactives` (restriction
individuelle, ne peut jamais réactiver ce que (1) a coupé, lignes 60-67).
Variante booléenne sans réponse HTTP : `estModuleDesactive(cabinetId, userId, cle)`
(lignes 88-94).

**`req.auth`** : posé dans `backend/src/middleware/requireAuth.ts:61`, typé
`AuthTokenPayload` (déclaration globale lignes 5-12, importé de
`../services/auth`). Vérifie aussi `user.actif` et `cabinet.actif`/
`essaiExpireLe` avant de poser `req.auth` (lignes 34-54).

**Employé sans compte** : un seul précédent existe — `model Huissier`
(`schema.prisma:341-353`, annuaire externe simple : `id`, `cabinetId`, `nom`,
`email`, `telephone`, lié au `Cabinet` sans login). **Aucun champ `userId`
nullable n'existe nulle part pour une entité "personnel interne" du
cabinet.** Il n'existe aujourd'hui **aucune table de personnel/RH** — tout
utilisateur interne passe obligatoirement par `User` (compte + login). Le
futur `FichePersonnel.userId String? @unique` devra suivre le même schéma
que `Huissier`, en ajoutant la relation optionnelle vers `User`.

## 2. Données (schéma Prisma, conventions, existant RH)

**Conventions** : champs en français côté modèle Prisma, `@map` snake_case
quasi systématique (ex. `schema.prisma:217` `policeDocuments @map("police_documents")`,
`:641-643` `cabinetId @map("cabinet_id")`, `numeroDossier @map("numero_dossier")`).
Chaque modèle a un `@@map("table_snake_case")` (ex. `:691` `@@map("dossiers")`).
`cabinetId` présent sur la quasi-totalité des modèles métier (62 occurrences),
absent seulement sur les tables de liaison pures (ex. `EvenementAssigne`).

**Migrations** : dossiers `AAAAMMJJHHMMSS_description_snake_case` (ex.
`20261013084459_notifications_et_affectation_multiple`, la plus récente).
Régénération de `portable-init.sql` via le script `prisma:portable-sql`
(`backend/package.json:18`), appelé automatiquement dans `build:sea`
(`package.json:21`).

**Existant RH** — recherche exhaustive, résultat **introuvable** pour tout :
congé/absence/solde, jour férié, stage/stagiaire, salaire/paie/rémunération,
mode de paiement. Le seul rôle existant reste l'enum `UserRole` ci-dessus
(pas de rôle "stagiaire"). Les seules occurrences de "paiement" concernent
la facturation **client** (`Facture.factureNormaliseeDatePaiement`,
`schema.prisma:1247`), sans rapport avec la paie du personnel.

**Conclusion** : le module RH est entièrement nouveau à construire — aucune
fondation de données à réutiliser au-delà de `User`/`Cabinet`.

## 3. Permissions et licences (Lot 9)

**`UtilisateurModuleAcces` (Lot 9) : non livré.** Recherche exhaustive dans
le schéma et `backend/src/**` : aucune occurrence. Le seul mécanisme
"individuel" existant est le champ `String[]` `User.modulesDesactives`
(`schema.prisma:386`) — une liste de clés *retirées*, pas une table de
droits positifs avec relations. C'est un système binaire par clé de module
(actif/inactif), pas des permissions granulaires séparées comme décrit dans
la spec. Mention trouvée dans `README-LOT10.md:85` : « Prépare le terrain
pour le Lot 9 (permissions granulaires par utilisateur), qui n'existe pas
encore à ce jour. » Aucun `README-LOT9.md` n'existe.

**Lecture de la licence** : `modulesActifs` vit dans la licence signée
(`backend/src/security/licenceManager.ts:40` schéma zod, `:111` payload),
pas directement sur `Cabinet`. Conversion via
`calculerModulesDesactives(modulesActifs)` (lignes 622-625) : si
`modulesActifs.includes("all")` → `[]` (tout actif), sinon tous les éléments
de `MODULES_DISPONIBLES` absents de `modulesActifs`. Résultat écrit dans
`Cabinet.modulesDesactives` à l'application de la licence (ligne 683).

**Clés de module existantes** (`backend/src/config/modulesDisponibles.ts:14-46`) :
`facturation`, `veille_juridique`, `jurisprudence`, `delais`,
`nouvelle_action`, `documents_generes`, `action_rediger`,
`action_recherche_juridique`, `action_recherche_jurisprudence`,
`action_resume_jurisprudence`, `action_transcription`, `action_traduction`,
`courriers`, `feuilles_temps`, `corbeille`. Toute clé hors de ce tableau est
rejetée à la création/modification de licence (commentaire lignes 1-6) :
ajouter `rh`/`rh_paie` nécessite de les ajouter ici et au type
`ModuleDisponible` (ligne 48).

Embryon annexe : `AccesSupplementaire` (`schema.prisma:516-526`) — donne à
un collaborateur un accès croisé aux données d'un avocat précis, mécanisme
différent (pas un système de permissions par module).

## 4. Notifications

Module présent et confirmé dans l'état actuel du code :
- Modèle `Notification` : `schema.prisma:1481-1500` (`id, cabinetId,
  destinataireId, type [String], titre, message?, lienUrl?, lu, luAt?,
  creeParId?, createdAt`, index `[destinataireId, lu]`).
- Service `backend/src/services/notifications.ts` : `creerNotification(params)`
  (ligne 17, refuse l'auto-notification), `creerNotificationsMultiples(ids, base)`
  (ligne 35, déduplique, exclut l'auteur, `createMany`).
- Routes `backend/src/routes/notifications.ts` : `GET /api/notifications`
  (13), `GET /api/notifications/compteur` (26), `PATCH /api/notifications/:id/lu`
  (33), `POST /api/notifications/tout-lire` (47), `POST /api/notifications/diffusion`
  (69).
- Front : `initNotificationsCloche(me)` appelée `layout.js:266`, définie
  ligne 328.

**Ajouter `type: "stage_echeance"` : trivial.** Le champ `type` est un
`String` brut, sans enum ni contrainte CHECK — aucune migration requise.
Seule chose à vérifier à l'implémentation : si un rendu/icône spécifique est
voulu pour ce type dans la cloche, l'ajouter dans `initNotificationsCloche`.

## 5. Tâches planifiées

Toutes en `node-cron`, timezone `Africa/Porto-Novo` (fixe, pas d'heure
d'été) :

| Fichier:ligne | Fréquence | Rôle |
|---|---|---|
| `backend/src/index.ts:390` | dim. 5h | Vérification licence (phone-home) |
| `backend/src/index.ts:435` | lun. 7h | Veille juridique hebdomadaire |
| `backend/src/index.ts:470` | ven. 8h | Récap rôle de la semaine |
| `backend/src/index.ts:484` | lun. 6h | Jobs de rétention (purge audit, archivage) |
| `backend/src/jobs/liberationVerrousExpires.ts:50` | */30 min | Libère les verrous d'édition abandonnés |
| `backend/src/jobs/purgeCorbeille.ts:180` | 2h/jour | Purge corbeille |
| `backend/src/jobs/suppressionDelaisExpires.ts:54` | 4h/jour | Suppression délais expirés |
| `backend/src/jobs/purgeAudioMobile.ts:44` | 3h/jour | Purge audio mobile |
| `backend/src/jobs/traitementOcr.ts:235` | variable | Rattrapage OCR |
| `backend/src/database/backupScheduler.ts:132` | configurable | `pg_dump` planifié |
| `backend/src/services/calendrierSync/syncQueue.ts:189` | variable | Sync calendrier externe |
| `backend/src/services/emailIngestion/polling.ts:142` | variable | Polling emails entrants |

**Mécanisme de rattrapage (catch-up), critique pour le futur job RH** :
pattern implémenté pour la veille juridique et le récap de rôle. Fonction
générique `dernierCreneauPasse(maintenant, jourSemaineUtc, heureUtc)`
(`backend/src/utils/creneauHebdomadaire.ts:21`, calcul en UTC pur, sans
dépendance de fuseau externe). `runVeillePourTousLesCabinets`
(`backend/src/services/veilleJuridique.ts:126-145`) compare
`Cabinet.veilleDerniereExecution` (horodatage persisté) au créneau attendu
— si déjà ≥, on saute (idempotence, jamais de doublon même après plusieurs
redémarrages la même semaine) ; sinon on exécute puis on met à jour
l'horodatage. Appelé **une fois au démarrage** (`index.ts:429`, rattrape un
créneau manqué si l'app était fermée) **et** par le cron hebdomadaire
(`index.ts:449`). Même patron dupliqué pour le récap de rôle. Tests de
référence : `veilleJuridique.rattrapage.test.ts`,
`roleSemaineRecap.rattrapage.test.ts`.

C'est exactement le patron à reprendre pour les rappels de fin de stage
(J-30/J-15/J-7/J-0) : un horodatage de dernière notification envoyée
comparé à un créneau calculé, jamais deux fois le même rappel.

## 6. Calendrier et audiences — lien avocat↔audience

- **`Dossier`** (`schema.prisma:641-694`) : seul `createdBy` (673, créateur,
  pas forcément un avocat) — **aucun champ `avocatResponsableId` ou
  équivalent.**
- **`RoleAudience`** (`schema.prisma:920-947`) : `cabinetId` (923),
  `dossierId` optionnel (924), `createdBy` (934) — **aucun champ identifiant
  un avocat précis en charge de l'audience.**
- **`Evenement`** (`schema.prisma:958-1001`) : `createdById` (971),
  `updatedById` (976). Rattachement à des utilisateurs précis uniquement
  via `EvenementAssigne` (schema.prisma:1006-1015, many-to-many libre,
  pas garanti de représenter "l'avocat titulaire").

**Verdict : impossible aujourd'hui** de déterminer de façon fiable "quel
avocat a une audience tel jour" pour la détection de conflit du planning de
congés. Un champ explicite (`avocatResponsableId` sur `Dossier` et/ou
`RoleAudience`) devra être ajouté avant RH-4, ou la détection de conflit
devra être désactivée et signalée comme telle en V1 — exactement le point
que la spec elle-même anticipait ("à confirmer par l'audit", section 5.3).

## 7. PDF et exports

- `pdfkit` (`backend/package.json:47`, `^0.19.1`) utilisé dans :
  `services/courriers/courrierDocx.ts`, `services/roleSemaineExport.ts`,
  `services/feuillesTemps.ts`, `services/facturePdf.ts`,
  `services/ocr/ocrTexteExport.ts`, `services/documentExport.ts`.
- `docx` (`package.json:33`, `^9.7.1`) utilisé notamment par `courrierDocx.ts`.
- `backend/src/services/documentExport.ts` est un **service**, pas une
  route exposée directement.
- **Bibliothèque Excel/CSV : introuvable** — aucune dépendance de ce type
  dans `package.json` aujourd'hui.
- **En-tête/logo du cabinet** — deux champs distincts sur `Cabinet` :
  `enteteUrl` (`schema.prisma:221`, inséré dans les documents à la demande)
  et `logoUrl` (`:227`, affichage UI uniquement, jamais dans un document).
  Routes : `GET /api/cabinet/identite-publique` (`routes/cabinet.ts:18`,
  sans auth) et `GET /api/cabinet` (ligne 25, avec auth, renvoie aussi
  `enteteUrl`, `policeDocuments`, `tailleDocuments`).

## 8. Stockage et chiffrement

**`backend/src/security/encryptionAtRest.ts`** (215 lignes, AES-256-GCM,
`node:crypto` seul) :
- `loadOrCreateEncryptionKey(): Buffer` (80) — clé par installation,
  priorité `AURORE_ENCRYPTION_KEY` (env) puis fichier local.
- `encryptField`/`decryptField` (128/140) — **texte uniquement**,
  rétro-compatible avec du clair pré-migration.
- `encryptJsonField`/`decryptJsonField` (182/193) — sérialisation JSON avant
  chiffrement.
- Erreur dédiée `FieldEncryptionError` (24).

**Aucune primitive pour chiffrer un entier/décimal directement.** Pour un
champ RH numérique sensible (montant), il faudra soit le stocker en texte
chiffré (perte du typage SQL, du tri et de l'agrégation SQL — sommes à
calculer en JS après déchiffrement), soit étendre ce module. C'est un point
d'architecture à trancher avant RH-5.

**Champs déjà chiffrés** (registre `backend/src/security/prismaEncryption.ts:17-61`) :
`Client` (nom, email, téléphone, pièce d'identité, adresse...), `Action`
(contenuGenere, champsDocument en JSON), jetons OAuth/CalDAV/IMAP,
`Cabinet.mobileServerClePrivee`, `MobileItem.noteTexte`. Application via une
extension Prisma générique (`withEncryptionAtRest`, ligne 252) qui chiffre à
l'écriture et déchiffre récursivement (y compris les relations imbriquées) à
la lecture — aucun code appelant n'a besoin de chiffrer/déchiffrer à la main.

**`backend/src/services/stockageDocuments.ts`** : chiffrement de fichiers
binaires (même clé, AES-256-GCM, fonctions `chiffrerBuffer`/`dechiffrerBuffer`,
format `IV(12o) || AuthTag(16o) || ciphertext` brut sur disque). Réutilisable
tel quel pour les PDF de paie.

**Sauvegardes** (`backend/src/database/backupScheduler.ts:92-104`,
`pg_dump -F c`, dump complet sans filtre de table) : **toute nouvelle table
RH sera automatiquement couverte**, aucune configuration supplémentaire.

## 9. Journal d'audit

**Modèle `AuditLog`** (`schema.prisma:1534-1552`) : `id`, `actionId?`,
`courrierEntrantId?`, `courrierSortantId?`, `etape`, `statut`, `detail?`
(texte libre, sans limite de longueur déclarée), `timestamp`. **Aucun champ
`userId` en relation** — l'identité de l'auteur, quand elle apparaît, est
injectée en texte libre dans `detail` (convention observée :
`` `Créé par ${userId}` `` avec l'UUID brut, jamais nom/email).

**Service** : `logAuditStep(actionId, etape, statut, detail?)` et
`logAuditCourrier(lien, etape, statut, detail?)` — `backend/src/services/audit.ts`.

**Aucun garde-fou automatique** (ni troncature, ni anonymisation) au niveau
du service d'écriture : la non-sensibilité du contenu repose entièrement sur
la discipline de l'appelant. Le futur module RH devra suivre strictement la
même convention manuelle.

**Front** : `backend/public/audit-logs.html` (journal cabinet),
`backend/public/journal-plateforme.html` (vue plateforme).

## 10. Front

`backend/public/` : fichiers HTML par écran à la racine (~30, dont les
écrans `admin-*`/`journal-plateforme.html` réservés `super_admin`), dossier
`js/` (logique partagée), `style.css`, images.

**Navigation par rôle/module** : `NAV_ITEMS` (`layout.js:28-88`), chaque
entrée porte `roles: [...]` et un `moduleKey` optionnel ; filtrage ligne
128-130 (`roles.includes(me.role) && (!moduleKey || !modulesDesactives.includes(moduleKey))`).

**`downloadFile` existe** : `backend/public/js/api.js:80` — contourne
l'impossibilité d'ouvrir `target=_blank` dans la webview Tauri via un
`fetch` + `Blob` + lien `<a download>` déclenché par programme.

**Pattern `.modal-overlay`/`.modal-box`** confirmé (`style.css:1061`/`1072`).
Exemple de liste à cocher pour une assignation : `calendrier.html:93-94` +
`renderAssignesCheckboxes` (`js/calendrier.js:422-433`) — même pattern que
celui utilisé ce soir pour l'affectation de courriers et la diffusion de
notifications.

## 11. Monnaie et formats

Fonction `formatMontant(montant)` dupliquée à l'identique dans trois
fichiers (pas de module partagé) : `factures.html:99-101`,
`admin-factures.html:36-38`, `factures-payees.html:64-66` — toutes :
`` `${montant.toLocaleString("fr-FR")} F CFA` ``. Même pattern inline (sans
fonction nommée) dans `js/timer.js:119,128`, `tableau-de-bord.html:250`,
`js/layout.js:793`, `js/feuilles-temps.js:112`. **Aucune fonction
équivalente côté `backend/src/`** — le formatage est purement front, à
dupliquer ou à factoriser pour le module RH.

## 12. Risques (classés par priorité)

1. **Lot 9 non livré, contrairement au prérequis de la spec.** Le système
   actuel (cabinet + individuel, par clé de module binaire) peut suffire
   pour `rh`/`rh_paie` en V1 (ajouter deux clés à `MODULES_DISPONIBLES`),
   mais ne permet PAS ce que la spec décrit section 3 ("le titulaire peut
   ouvrir `rh_paie` à une personne précise sans lui ouvrir `rh`") de façon
   fine — `User.modulesDesactives` retire un module pour un utilisateur,
   il n'accorde pas un accès que son rôle n'aurait pas par défaut. À
   trancher avant RH-1.
2. **Lien avocat↔audience inexistant.** Bloque la détection de conflit du
   planning de congés (section 5.3 de la spec) tant qu'un champ explicite
   n'est pas ajouté sur `Dossier`/`RoleAudience`. Impact direct sur RH-4.
3. **Chiffrement des montants non supporté nativement.** `encryptionAtRest.ts`
   ne chiffre que du texte/JSON, jamais un entier. Impact sur RH-5
   (fiches de paie) et le calcul des totaux (agrégation SQL impossible sur
   du texte chiffré).
4. **Aucune bibliothèque Excel.** L'export Excel de l'état de paiement
   (section 5.5 de la spec) nécessite une nouvelle dépendance si on ne se
   limite pas au PDF/CSV.
5. **Journal d'audit sans garde-fou automatique.** La confidentialité
   (section 8 de la spec, "sans montant ni contenu") reposera entièrement
   sur la discipline du code RH, comme pour le reste du projet aujourd'hui.

## Contradictions avec la spec

- **Prérequis explicite non rempli** : la spec indique en en-tête "Lot 9
  (permissions granulaires) livré. Ne pas démarrer RH-1 avant." — l'audit
  confirme que ce Lot n'existe pas. Décision nécessaire : adapter la spec
  au système binaire actuel, ou livrer un vrai Lot 9 avant RH-1.
- Le reste de la spec ne contredit pas le code réel : elle anticipe
  correctement plusieurs zones d'incertitude ("à confirmer par l'audit")
  qui se confirment effectivement comme des trous (lien avocat↔audience,
  bibliothèque Excel, mécanisme de rattrapage des jobs).

## Questions à trancher

1. Le Lot 9 (permissions granulaires) n'existe pas. Démarre-t-on RH-1 avec
   le système binaire actuel (`modulesDesactives` cabinet + individuel), ou
   faut-il d'abord construire un vrai Lot 9 avant RH-1 ?
2. Pour le lien avocat↔audience (nécessaire à RH-4) : ajoute-t-on un champ
   `avocatResponsableId` sur `Dossier` et/ou `RoleAudience`, ou désactive-t-on
   la détection de conflit en V1 avec un avertissement visible ?
3. Pour les montants chiffrés (RH-5) : les stocker en texte chiffré (totaux
   calculés en JS après déchiffrement, jamais en SQL), ou laisser les
   montants en clair en base et ne chiffrer que les coordonnées de paiement
   et le PDF ?
4. Export Excel de l'état de paiement : ajoute-t-on la dépendance
   `exceljs`, ou se limite-t-on à PDF/CSV en V1 ?
5. Granularité du job de rappel de stage (J-30/J-15/J-7/J-0, idempotent) :
   un horodatage unique par stage (dernier rappel envoyé), ou un
   enregistrement séparé par échéance pour garantir qu'aucun rappel n'est
   ni dupliqué ni oublié en cas de redémarrage ?

## Décisions validées (2026-10-13)

1. **Lot 9** : on démarre avec le système binaire actuel (`Cabinet.modulesDesactives`
   + `User.modulesDesactives`). Pas de vrai Lot 9 granulaire avant RH-1.
   `rh`/`rh_paie` suivent la même mécanique que les clés de module existantes.
2. **Lien avocat↔audience** : à ajouter avant RH-4 — champ
   `avocatResponsableId` sur `Dossier` (migration additive, nullable). La
   détection de conflit du planning de congés (section 5.3 de la spec)
   s'appuiera dessus plutôt que d'être désactivée.
3. **Montants de paie** : stockés **en clair** en base (entiers FCFA),
   permettant des totaux fiables en SQL. Seuls les coordonnées de paiement
   (`FichePersonnel.coordonneesPaiement`) et les PDF de paie sont chiffrés
   au repos, comme déjà prévu dans la spec section 4 et 8.
4. **Export Excel** : pas de nouvelle dépendance en V1. L'état de paiement
   s'exporte en PDF et CSV uniquement (un CSV s'ouvre nativement dans
   Excel). `exceljs` pourra être ajouté plus tard si un cabinet le demande
   explicitement.
5. **Rappels de stage** : un enregistrement par échéance (J-30/J-15/J-7/J-0),
   pas un horodatage unique par stage — chaque palier est vérifié et
   marqué indépendamment, pour qu'un décalage de calcul ne puisse jamais
   faire sauter silencieusement un rappel.

Ces décisions s'appliquent aux prompts RH-1 à RH-7 à venir.
