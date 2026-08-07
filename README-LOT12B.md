# Lot 12b : synchronisation calendrier externe (Google Calendar + CalDAV)

Synchronisation **sortante uniquement** (Aurore → agenda externe), **par
utilisateur** (OAuth2/CalDAV individuel, jamais un compte cabinet partagé),
**strictement asynchrone** (aucune requête vers Google/CalDAV n'est jamais
attendue par une réponse HTTP côté Aurore). Consomme le modèle `Evenement`
du Lot 12a sans le modifier ; ne touche à aucune logique métier existante
(calcul des délais, génération d'actes).

## Architecture

```
services/calendrierSync/
  adapter.ts        Interface commune CalendrierExterneAdapter
                     (creerEvenement / modifierEvenement / supprimerEvenement)
  googleCalendar.ts  OAuth2 (auth URL, echange de code, refresh token) +
                     adaptateur Google Calendar (fetch natif, API REST v3)
  caldav.ts          Decouverte du calendrier principal (PROPFIND) +
                     adaptateur CalDAV generique (PUT/DELETE + iCalendar)
  syncQueue.ts       File d'attente (table EvenementSyncExterne) + cycle
                     planifie (node-cron, toutes les 2 minutes)

routes/calendrierExterne.ts   OAuth Google (connecter/callback), CalDAV
                               (connecter), statut, deconnexion
public/parametres-calendrier.html + js/parametres-calendrier.js
                               Ecran de connexion, lie depuis "Mon profil"
```

## Pourquoi une table plutôt qu'une queue en mémoire (à trancher/documenter, demande explicite du prompt)

`EvenementSyncExterne` (statuts `en_attente` / `synchronise` / `erreur` /
`a_supprimer`) **est** la file d'attente - pas de queue en mémoire séparée.
Justification : le volume attendu pour un cabinet d'avocats est faible
(quelques événements par jour, jamais des milliers) - aucun besoin de débit
élevé qui justifierait une queue en mémoire. En contrepartie, une queue en
mémoire perdrait tout son contenu à chaque redémarrage du serveur
(déploiement, mise à jour, coupure électrique côté poste desktop) ; une
table Postgres survit nativement, sans code de persistance supplémentaire.
Le "worker" est un cycle `node-cron` toutes les 2 minutes (même mécanisme
que les autres jobs du projet - `jobs/liberationVerrousExpires.ts`, Lot 11).

## Écart assumé par rapport à la spec : pas de `Evenement.externalEventId`

La spec suppose ce champ "déjà prévu au Lot 12a" - il ne l'était pas
(vérifié : absent du schéma livré au Lot 12a). Plutôt qu'un simple scalaire
sur `Evenement` (qui ne modéliserait qu'**une seule** cible externe), une
table `EvenementSyncExterne` (evenementId, connexionId, externalEventId,
statut) a été créée : un même `Evenement` peut légitimement se synchroniser
vers **plusieurs** agendas externes (ex. le créateur ET un assigné ont
chacun leur propre Google Calendar connecté). Un scalaire unique ne
permettait pas de représenter ce cas.

**Périmètre de synchronisation retenu** : un `Evenement` se synchronise vers
les connexions actives de son créateur (`createdById`) et de tous ses
assignés (`EvenementAssigne`) - la spec parle de "l'utilisateur assigné"
(singulier) sans trancher le cas à plusieurs assignés ; ce choix couvre les
deux.

**Suppression et FK `SetNull`** : `EvenementSyncExterne.evenementId` est
nullable avec `onDelete: SetNull` (pas `Cascade`) - une ligne de suivi doit
**survivre** à la suppression de l'`Evenement` Aurore le temps que le cycle
de synchro supprime aussi l'événement côté externe (statut `a_supprimer`,
posé par le hook *avant* la suppression réelle). Une fois traitée
(succès ou abandon après `MAX_TENTATIVES` échecs), la ligne est supprimée.

## Chiffrement des tokens/identifiants

`ConnexionCalendrierExterne.accessToken`/`refreshToken`/`caldavPassword`
sont chiffrés au repos en réutilisant **tel quel** le mécanisme du Lot 2bis
(`security/prismaEncryption.ts`) : ajout d'une entrée dans
`ENCRYPTED_FIELDS_BY_MODEL`, chiffrement/déchiffrement ensuite **transparent**
pour tout le reste du code (aucun appel manuel à `encryptField`/`decryptField`
nulle part dans ce lot). `caldavUsername`/`caldavUrl`/`calendrierUrl` restent
en clair (configuration, pas des secrets - affichés tels quels dans l'écran
de statut). Vérifié par un test e2e qui relit la colonne en base via SQL
brut (`enc:v1:` en préfixe) puis via Prisma (valeur en clair, déchiffrement
transparent confirmé).

## Refresh token Google

`assurerAccessTokenValide()` (`googleCalendar.ts`) renouvelle automatiquement
un `access_token` expiré (ou expirant dans moins de 2 minutes) via le
`refresh_token`, persiste le nouveau token (chiffré, transparent), et le
renvoie - jamais besoin de redemander la connexion à l'utilisateur
(comportement standard OAuth2, contrainte explicite du prompt). `access_type=
offline` + `prompt=consent` dans l'URL de consentement garantissent la
réception d'un `refresh_token` à **chaque** connexion (Google ne le renvoie
sinon que la toute première fois pour un compte/app donnés - critique pour
une reconnexion après révocation).

## Procédure d'obtention des credentials OAuth Google (développement/test)

1. [Google Cloud Console](https://console.cloud.google.com/) → créer un
   projet (ou en réutiliser un) → **APIs & Services > Library** → activer
   **Google Calendar API**.
2. **APIs & Services > OAuth consent screen** → type "External" (ou
   "Internal" si Google Workspace) → renseigner nom de l'app, email de
   support → scope à ajouter : `https://www.googleapis.com/auth/calendar.events`
   → en mode test, ajouter les comptes Google de test comme "Test users".
3. **APIs & Services > Credentials** → **Create Credentials > OAuth client
   ID** → type "Web application" → **Authorized redirect URIs** : ajouter
   exactement `http://127.0.0.1:3000/api/calendrier-externe/google/callback`
   (mode desktop/portable, port fixe - voir `src-tauri/src/main.rs`) et/ou
   l'URL réelle du serveur VPS en mode externe/réseau.
4. Copier le **Client ID** et le **Client Secret** générés dans
   `.env` : `GOOGLE_CALENDAR_OAUTH_CLIENT_ID`, `GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET`
   (`GOOGLE_CALENDAR_OAUTH_REDIRECT_URI` seulement si différent du défaut
   127.0.0.1:3000 ci-dessus).
5. Un seul jeu de credentials suffit pour **toute** l'installation (tous les
   cabinets, tous les utilisateurs) - chaque utilisateur effectue ensuite sa
   propre connexion individuelle via "Mon profil > Calendrier externe",
   produisant ses propres tokens stockés à part.

Sans ces variables configurées, le reste de l'application fonctionne
normalement - seul le bouton "Connecter Google Calendar" échoue avec un
message explicite (`MissingConfigurationError`, même mécanisme que les clés
LLM/Tavily manquantes).

## Choix CalDAV pour les autres fournisseurs

Un seul client générique (RFC 4791), sans code spécifique à un fournisseur :
1. `PROPFIND` sur l'URL fournie par l'utilisateur → `current-user-principal`.
2. `PROPFIND` sur le principal → `calendar-home-set`.
3. `PROPFIND` (Depth 1) sur le home-set → premier enfant dont le
   `resourcetype` contient `calendar`.
4. Chaque événement = un fichier `.ics` (`PUT`/`DELETE`) dans cette
   collection, au format iCalendar (`VEVENT`, RFC 5545).

Couvre Outlook.com, iCloud, Baikal et tout serveur CalDAV standard avec le
même code. **Proton Calendar** : CalDAV n'est disponible que sur les plans
payants Proton (Mail Plus et supérieur) - non testable avec un compte
gratuit. **Limite assumée** : l'extraction des réponses XML `PROPFIND` est
volontairement simple (regex ciblées sur les 2-3 éléments nécessaires), pas
un parseur XML complet - suffisant pour ces requêtes précises et
structurellement prévisibles chez les fournisseurs standards ; une
régression réelle resterait détectable (erreur explicite "aucun calendrier
trouvé"), jamais un plantage silencieux.

## Limite fondamentale : sens unique (V1)

**Aurore → agenda externe uniquement.** Un événement créé ou modifié
**directement dans Google Calendar/l'agenda CalDAV** (pas dans Aurore)
n'est **jamais** importé ni détecté - conforme à l'objectif explicite du
prompt ("Ne pas importer les événements créés directement dans l'agenda
externe"). Un utilisateur qui modifie ou supprime côté externe un événement
poussé par Aurore verra Aurore **écraser** ce changement au prochain cycle
de synchro (la version Aurore fait toujours foi) - à communiquer clairement
au cabinet.

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié - `ConnexionCalendrierExterne`,
  `EvenementSyncExterne`, enums `ProviderCalendrierExterne`/`StatutSyncExterne`)
- `backend/prisma/migrations/20260807030000_sync_calendrier_externe/migration.sql` (nouveau)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/security/prismaEncryption.ts` (modifié - champs sensibles enregistrés)
- `backend/src/services/calendrierSync/{adapter,googleCalendar,caldav,syncQueue}.ts` (nouveaux)
- `backend/src/routes/calendrierExterne.ts` (nouveau)
- `backend/src/routes/evenements.ts` (modifié - hooks POST/PATCH/DELETE)
- `backend/src/services/evenementSync.ts` (modifié - hooks Lot 12a → Lot 12b)
- `backend/src/config/env.ts`, `.env.example`, `config/bundledExternalServiceKeys.ts`, `src/index.ts` (modifiés - credentials OAuth Google, planification du cycle de synchro)
- `backend/src/app.ts` (modifié - enregistrement du routeur)
- `backend/public/parametres-calendrier.html`, `backend/public/js/parametres-calendrier.js` (nouveaux)
- `backend/public/profil.html` (modifié - lien "Calendrier externe")
- Tests : `services/calendrierSync/__tests__/{caldav,googleCalendar,syncQueue}.test.ts` (25 tests unitaires), `tests/e2e/calendrier-externe.test.ts` (9 tests)
- `README-LOT12B.md` (ce fichier)

**Non modifiés** (vérifié) : `services/delais.ts` (moteur de calcul),
toute la logique de génération de documents, le modèle `Evenement` lui-même
(Lot 12a) hormis l'ajout de la relation inverse `syncsExternes`.

## Ce qui a été réellement testé

Suite complète du projet rejouée : **165/165 tests passés**, `tsc --noEmit`
propre, `eslint` sans nouvelle erreur (3 erreurs préexistantes, hors
fichiers de ce lot).

**Aucun compte Google ni serveur CalDAV réel n'est disponible dans cet
environnement** - les adaptateurs sont mockés à la frontière
`services/calendrierSync/{googleCalendar,caldav}.ts` : tout le reste
(routes, hooks, `syncQueue.ts`, chiffrement Prisma) tourne en conditions
réelles contre une vraie base PostgreSQL jetable.

- `syncQueue.test.ts` (11 tests, unitaire, Prisma + adaptateurs mockés) :
  mise en file (créateur + assignés, connexions actives uniquement), aucune
  mise en file si aucune connexion, résilience du hook (ne rejette jamais),
  création puis passage `synchronise`, modification sans duplication,
  résilience réseau (tentatives incrémentées, statut `erreur`), suppression
  externe puis nettoyage de la ligne, abandon après `MAX_TENTATIVES`,
  sélection du bon adaptateur selon le `provider`.
- `googleCalendar.test.ts` (9 tests, unitaire, `fetch` mocké) : erreur de
  configuration explicite si credentials absents, construction de l'URL
  OAuth (scope minimal, `state`), échange de code, refus explicite sans
  `refresh_token`, renouvellement automatique du token expiré (persisté,
  jamais de redemande de connexion), CRUD Google Calendar (404 = jamais une
  erreur à la suppression).
- `caldav.test.ts` (5 tests, unitaire, fonction pure) : format iCalendar
  correct (horodaté et toute-la-journée), échappement RFC 5545, durée par
  défaut.
- `calendrier-externe.test.ts` (9 tests, e2e, PostgreSQL réel + adaptateurs
  mockés) : **chiffrement réel vérifié en base** (SQL brut), **non-blocage
  réel vérifié** (l'adaptateur mocké n'est pas appelé avant le cycle
  explicite), synchro création/modification (pas de duplication),
  **résilience réseau réelle** (échec puis rattrapage au cycle suivant,
  `Evenement` Aurore jamais affecté), suppression, **déconnexion réelle**
  (connexion supprimée, `Evenement` intact, aucune suppression rétroactive
  côté externe), aucune mise en file pour un utilisateur sans connexion.

## Non testé dans cet environnement (à faire manuellement avant mise en production)

- **Connexion Google réelle de bout en bout** : obtenir de vrais credentials
  OAuth (procédure ci-dessus), connecter un vrai compte Google de test,
  vérifier l'apparition réelle d'un événement dans Google Calendar.
- **CalDAV avec un vrai compte Outlook.com** (et Proton Calendar sur un plan
  payant, iCloud) : la découverte du calendrier principal (PROPFIND) n'a
  été vérifiée que contre des réponses XML construites à la main dans les
  tests - un vrai serveur pourrait renvoyer une structure légèrement
  différente de ce qu'anticipe l'extraction volontairement simple (voir
  limite CalDAV ci-dessus).
- **Rendu visuel réel** de l'écran "Calendrier externe" (`parametres-calendrier.html`)
  dans un navigateur - relu et syntaxiquement validé (`node --check`), pas
  cliqué.
- **Comportement du cycle de synchro sur plusieurs jours/redémarrages
  réels** du serveur (au-delà de ce que les tests peuvent simuler
  instantanément).
