# Lot 16 : ingestion email assistée (pièces jointes + détection de RDV)

Connecte une boîte mail (Gmail ou IMAP générique) pour retrouver, dans un
écran dédié « Boîte de réception », les emails récents avec une suggestion
de dossier (si l'expéditeur correspond à un `Client.email` connu), les
pièces jointes détectées et une date/heure de rendez-vous détectée dans le
corps du message — **jamais rien n'est écrit automatiquement** : chaque
import de pièce et chaque création d'événement passe par une confirmation
explicite de l'utilisateur, avec correction possible de la date avant
validation. Ne touche à aucune logique métier existante : `webActions.ts`,
`documentExport.ts` et les modules des Lots 12a/15 ne sont pas modifiés au-
delà de leur réutilisation en dépendance (`Evenement`, `stockageDocuments.ts`).

## Pourquoi aucun LLM sur le contenu des emails (V1)

Décision de scope explicitement documentée (demandée par le prompt) :
contrairement à `champsDocument` (Lot 5), qui bénéficie d'une
pseudonymisation avant tout envoi à un fournisseur LLM tiers, le corps d'un
email peut contenir des informations sensibles **sans aucune garantie
équivalente**. Plutôt que d'inventer un nouveau mécanisme de
pseudonymisation spécifique aux emails (risque de fuite si mal calibré), la
détection de date en V1 est **entièrement locale** : des patterns
regex en TypeScript pur (`detectionDate.ts`), sans aucun appel réseau vers
un tiers pour ce traitement. Contrepartie assumée : la couverture est plus
limitée qu'une extraction par IA (voir formats reconnus ci-dessous).

**Évolution V2 possible** (hors scope de ce lot) : un appel LLM sur le
corps de l'email, à condition de définir d'abord un mécanisme de
pseudonymisation adapté au texte libre d'un email (distinct de celui de
`champsDocument`, qui opère sur des champs structurés) — non trivial, donc
volontairement reporté plutôt que fait à la légère.

## `detectionDate.ts` — formats reconnus (documentés dans le code)

Fonction **pure** (`detecterDate(texte, dateReference)`), testée
indépendamment sans base de données (`__tests__/detectionDate.test.ts`, 16
tests). Le premier format qui matche gagne, par ordre de **fiabilité** (pas
par position dans le texte) :

1. **Date numérique complète**, heure optionnelle : `12/08/2026`,
   `12-08-2026`, `12/08/2026 à 10h30`.
2. **Date littérale** (jour + mois en lettres), jour de semaine et année
   optionnels, heure optionnelle : `12 août`, `mardi 12 août`,
   `le 12 août à 10h30`. Année absente → déduite de la date de réception
   (année suivante si la date obtenue tombe déjà dans le passé, ex. un
   email de décembre évoquant « le 5 janvier »).
3. **Date relative** au jour de réception : `aujourd'hui`, `demain`,
   `après-demain`, heure optionnelle (défaut 9h00 si absente).
4. **Jour du mois seul**, **uniquement** introduit par « le » **et**
   accompagné d'une heure explicite (sinon rejeté — trop ambigu, ex. « le
   12 » pourrait être un numéro de dossier) : `le 12 à 10h` → prochaine
   occurrence de ce jour (mois courant si pas encore passé, sinon mois
   suivant).

**Limites volontairement non couvertes** (documentées en tête de fichier) :
expressions vagues (« la semaine prochaine », « courant septembre »),
plages horaires, fuseaux horaires explicites, plusieurs dates dans un même
email (seule la première par ordre de priorité ci-dessus est proposée),
dates entièrement en toutes lettres (« le douze août »).

Le contexte renvoyé avec chaque détection (`dateDetecteeContexte`, affiché
à l'utilisateur avant confirmation) est un **court extrait** (~60-80
caractères) autour du texte reconnu — jamais le corps complet de l'email
(voir « Aucun contenu complet stocké » ci-dessous).

## `suggestionDossier.ts` — correspondance exacte uniquement

`Client.email` est **chiffré au repos** (`security/prismaEncryption.ts`,
Lot 2bis) : un `WHERE email = ...` côté SQL est structurellement impossible
(le texte stocké est un ciphertext avec IV aléatoire, deux chiffrements de
la même valeur produisent des octets différents). La comparaison se fait
donc **côté application**, sur des enregistrements lus normalement via
Prisma (déchiffrement transparent) — jamais de filtre `email` dans un
`where` Prisma pour ce modèle.

Correspondance **exacte uniquement** (trim + minuscules), **aucune**
approximation par nom, domaine ou distance textuelle : une suggestion
erronée est plus grave qu'une absence de suggestion, l'identité du client
étant en jeu (demande explicite du prompt). Un client peut avoir plusieurs
dossiers — tous sont suggérés, dédoublonnés si plusieurs fiches `Client`
partagent le même email.

## Gmail (OAuth2) vs IMAP (imapflow)

**Gmail** (`services/emailIngestion/gmailClient.ts`) : même pattern que
`services/calendrierSync/googleCalendar.ts` (Lot 12b) — `fetch` natif, pas
de SDK `googleapis`. Réutilise le **même client OAuth2 Google Cloud**
(`GOOGLE_CALENDAR_OAUTH_CLIENT_ID/SECRET`) que le calendrier — un seul jeu
de credentials suffit pour plusieurs scopes Google — mais avec une
`ConnexionEmailExterne` et une `redirect_uri`
(`GMAIL_INGESTION_OAUTH_REDIRECT_URI`) **strictement séparées** de
`ConnexionCalendrierExterne` : le scope demandé diffère
(`gmail.readonly` vs `calendar.events`), et coupler les deux flux
compliquerait inutilement la reconnexion/révocation indépendante de
chacun. Scope **lecture seule** — jamais de modification/suppression
d'email, jamais de libellé posé (principe du moindre privilège).

**IMAP générique** (`services/emailIngestion/imapClient.ts`, `imapflow`
1.6.6) : pour tout fournisseur non-Gmail (Outlook.com, boîte du cabinet,
etc.). Choix de bibliothèque justifié : le prompt suggère explicitement
`imapflow`, et contrairement au CalDAV du Lot 12b (protocole HTTP simple,
faisable à la main), IMAP est un protocole stateful à base de lignes bien
plus complexe à réimplémenter correctement — `imapflow` + `mailparser`
(types via `@types/mailparser`) ajoutés en dépendances, vérifiés par
`npm audit` avant/après : **aucune nouvelle vulnérabilité** introduite (les
10 préexistantes — 4 modérées, 5 hautes, 1 critique — sont toutes des
dépendances transitives d'outils de dev déjà présents : eslint8, vite,
vitest2, prisma-cli). Strictement **lecture seule** : uniquement
`connect`/`getMailboxLock`/`fetch`/`download`/`logout`, jamais d'écriture
de flag ni de suppression.

## Aucun contenu complet stocké, aucune automatisation silencieuse

- Le corps de l'email (`email.corpsTexte`) n'existe qu'**en mémoire**, le
  temps du calcul de `detecterDate()` lors d'un cycle de polling — jamais
  écrit dans `EmailImporte` (seuls `dateDetectee` et un court extrait de
  contexte le sont).
- Les **pièces jointes** ne sont **jamais téléchargées** au simple
  listage : seule leur métadonnée (nom, type MIME, taille, identifiant
  opaque côté fournisseur) est extraite et stockée dans
  `EmailImporte.piecesJointes` (JSON). Le contenu binaire n'est récupéré
  (`telechargerPieceJointe`) **qu'au moment de la confirmation explicite
  d'import** par l'utilisateur.
- Le polling (`services/emailIngestion/polling.ts`, toutes les 5 minutes,
  `node-cron`) n'écrit **que** des lignes `EmailImporte` — jamais de
  `DocumentDossier` ni d'`Evenement`. Ces deux modèles ne sont créés que
  par les deux routes de confirmation explicite
  (`POST .../importer-piece`, `POST .../confirmer-evenement`), jamais
  ailleurs — vérifié par un test e2e dédié qui fait tourner **trois**
  cycles de polling consécutifs et vérifie qu'aucun document ni événement
  n'existe avant toute action de l'utilisateur.
- Un email déjà connu (même `identifiantExterne`) n'est **jamais
  réécrasé** par un cycle de polling suivant (`upsert` avec `update: {}`)
  — un statut `traite` posé par l'utilisateur ne redevient jamais
  `nouveau` simplement parce que l'email est encore présent au cycle
  suivant.
- Logs (`console.log`/`console.error`, préfixe `[email-ingestion]` — même
  convention que les autres modules, `AuditLog.actionId` étant une FK
  obligatoire vers `Action`, structurellement inutilisable ici) : **jamais**
  le contenu d'un email, uniquement métadonnées (expéditeur, nombre de
  pièces, message d'erreur technique).

## Boîte mail strictement individuelle

Comme pour le calendrier externe (Lot 12b), une connexion
(`ConnexionEmailExterne`) appartient à **un utilisateur**, jamais un compte
cabinet partagé. La liste « Boîte de réception »
(`GET /api/email-ingestion/emails`) est scopée aux connexions du **seul
utilisateur courant** — un autre membre du même cabinet ne voit ni ne peut
agir sur les emails d'autrui (`404` sur toute route d'action référençant un
email d'un tiers), vérifié par un test e2e dédié. L'import de pièce et la
création d'événement suivent en revanche la règle d'accès cabinet-large
habituelle sur le **dossier ciblé** (même convention que
`documentsDossier.ts`, Lot 15 : tout membre du cabinet peut importer vers
un dossier de son cabinet).

## Déconnexion : aucune donnée déjà importée affectée

`ConnexionEmailExterne` → `EmailImporte` est en cascade (`onDelete:
Cascade`) : déconnecter une boîte retire la liste « Boîte de réception »
associée. Mais `DocumentDossier.emailOrigineId` → `EmailImporte` est en
**`SetNull`** (pas cascade) : un document déjà importé **survit**
toujours, seule sa traçabilité vers l'email source est effacée. `Evenement`
n'a quant à lui **aucune relation** vers `EmailImporte` (juste
`source: "email"`, une valeur d'enum) — structurellement impossible à
affecter par une déconnexion. Vérifié par un test e2e dédié.

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié — `ConnexionEmailExterne`,
  `EmailImporte`, `SourceEvenement.email`, `DocumentDossier.emailOrigine`
  FK réelle vers `EmailImporte`)
- `backend/prisma/migrations/20260808000000_ingestion_email/migration.sql`
  (nouveau)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/services/emailIngestion/types.ts`,
  `gmailClient.ts`, `imapClient.ts`, `detectionDate.ts`,
  `suggestionDossier.ts`, `polling.ts` (nouveaux)
- `backend/src/routes/emailIngestion.ts` (nouveau)
- `backend/src/security/prismaEncryption.ts` (modifié — entrée
  `ConnexionEmailExterne` : `accessToken`/`refreshToken`/`imapPassword`)
- `backend/src/config/env.ts`, `.env.example` (modifiés —
  `GMAIL_INGESTION_OAUTH_REDIRECT_URI`)
- `backend/src/app.ts`, `backend/src/index.ts` (modifiés — enregistrement
  du routeur, planification du polling toutes les 5 minutes)
- `backend/public/parametres-email.html`, `js/parametres-email.js`
  (nouveaux — connexion/déconnexion Gmail + IMAP, dans « Mon profil »)
- `backend/public/boite-reception.html`, `js/boite-reception.js`
  (nouveaux — liste, suggestions, import de pièce, confirmation
  d'événement avec correction de date)
- `backend/public/profil.html`, `js/layout.js` (modifiés — lien « Boîte
  mail externe », entrée de navigation « Boîte de réception »)
- Dépendances : `imapflow`, `mailparser`, `@types/mailparser` (nouvelles)
- Tests : `src/services/emailIngestion/__tests__/detectionDate.test.ts`
  (16 tests), `.../suggestionDossier.test.ts` (8 tests),
  `tests/e2e/ingestion-email.test.ts` (8 tests)
- `README-LOT16.md` (ce fichier)

**Non modifiés** (vérifié) : `webActions.ts`, `documentExport.ts`,
`routes/evenements.ts`, `routes/documentsDossier.ts`,
`services/stockageDocuments.ts` (uniquement importé), les modules des
Lots 12a/12b/15 au-delà de la nouvelle valeur d'enum `SourceEvenement.email`.

## Ce qui a été réellement testé

Suite complète du projet rejouée : **247/247 tests passés**, `tsc --noEmit`
propre, `eslint` sans nouvelle erreur (3 erreurs préexistantes, hors
fichiers de ce lot).

`detectionDate.test.ts` (16 tests, unitaire, pur) : les 4 formats reconnus
(numérique, littéral, relatif, jour seul + heure), inférence d'année,
bascule de mois pour le format 4, rejet des dates invalides et des
expressions vagues non couvertes, priorité au format le plus fiable même
positionné après un format moins fiable dans le texte, longueur bornée du
contexte renvoyé.

`suggestionDossier.test.ts` (8 tests, unitaire, pur) : correspondance
exacte (avec normalisation casse/espaces), absence de suggestion pour un
expéditeur inconnu ou une adresse proche mais différente (pas
d'approximation), dédoublonnage, clients sans email/sans dossier.

`ingestion-email.test.ts` (8 tests, e2e, PostgreSQL réel, clients
Gmail/IMAP mockés à la frontière `services/emailIngestion/{gmailClient,
imapClient}.ts`) : rejet d'une connexion IMAP injoignable ; connexion
réussie avec identifiants chiffrés au repos (vérifié par lecture SQL
directe) ; polling sur trois cycles consécutifs sans création de document
ni d'événement, avec suggestion de dossier correcte et déduplication ;
import explicite d'une pièce jointe (document `source="email"`,
`emailOrigineId` correct, visible dans l'onglet Pièces) ; confirmation
d'un événement avec **correction de l'heure détectée** par l'utilisateur ;
boîte mail strictement individuelle (un autre utilisateur du même cabinet
ne voit ni ne peut agir sur les emails d'autrui) ; déconnexion sans effet
sur le document et l'événement déjà créés.

## Non testé dans cet environnement

- **Connexion Gmail/IMAP réelles** : aucun compte de test disponible dans
  cet environnement — les clients sont mockés à la frontière du module,
  le reste (routes, polling, détection, suggestion, chiffrement) tourne en
  conditions réelles.
- **Rendu visuel réel** de « Boîte de réception » et des formulaires de
  connexion dans un navigateur — relu et syntaxiquement cohérent, pas
  cliqué manuellement.
- **Volume réel** d'une boîte mail active (centaines d'emails, pièces
  jointes volumineuses) — les tests utilisent un unique email synthétique
  suffisant pour valider le mécanisme.
