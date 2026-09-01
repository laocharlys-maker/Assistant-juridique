# Lot 20 : mot de passe oublié (self-service, par code email)

Ajoute un mécanisme de récupération de compte pour un utilisateur qui a
oublié son mot de passe — cas rencontré concrètement lors d'un test en
situation réelle chez un avocat : un titulaire, seul admin de son cabinet,
n'avait strictement aucun moyen de se reconnecter (aucune route de
réinitialisation n'existait avant ce lot, ni self-service ni admin — vérifié
dans `routes/auth.ts` et `routes/users.ts`). Ne touche à aucune route
existante (`login`, `premier-lancement`, `logout`, `/me` inchangées) ni au
formulaire de connexion habituel.

## Choix : code à 6 chiffres saisi dans l'app, jamais un lien cliquable

Aurore est une appli desktop (Tauri + backend local), pas un site web avec
une URL publique stable — un lien de réinitialisation par email n'a pas
d'adresse fiable vers laquelle pointer (127.0.0.1 en poste unique,
`aurore.local` en réseau, adresse VPS en mode externe : trois bases d'URL
différentes selon le mode de déploiement, voir `README-LOT6.md`). Un code à
6 chiffres, saisi directement dans l'écran de connexion déjà ouvert, évite
ce problème entièrement — aucune notion d'URL de retour à gérer.

## Sécurité du code

- **Jamais stocké en clair** : seul `SHA-256(code)` est écrit en base
  (`User.resetCodeHash`), comparé en timing-safe
  (`crypto.timingSafeEqual`) à la vérification.
- **Expiration courte** : 15 minutes (`RESET_CODE_TTL_MS`), après quoi le
  code est rejeté même s'il est correct.
- **Usage unique** : `resetCodeHash`/`resetCodeExpiresAt` sont remis à
  `null` dès la réinitialisation réussie.
- **Aucune énumération de compte** : `POST /api/auth/mot-de-passe-oublie`
  renvoie **toujours** le même message générique (`200 { ok: true, ... }`),
  que l'email corresponde à un compte ou non, actif ou non — seule la
  branche interne diffère (génération + envoi, ou rien). Même principe côté
  vérification : `POST /api/auth/reinitialiser-mot-de-passe` renvoie
  toujours la même erreur générique ("Code invalide ou expiré"), qu'il
  s'agisse d'un compte introuvable, d'un code expiré ou d'un code erroné —
  jamais de détail qui permettrait de deviner lequel.
- **Rate limiting** : les deux routes réutilisent `loginLimiter` existant
  (10 requêtes/15 min par IP) plutôt qu'un nouveau middleware — protection
  déjà éprouvée sur ce type de route sensible.

## Envoi de l'email

Réutilise `services/mailer.ts` (`sendEmail`, Lot 19) et
`services/cabinetContact.ts` (`resolveCabinetEmailIdentite`) tels quels,
sans aucune modification — même mécanisme que tout autre email transactionnel
du produit (facture, test d'adresse de contact...). Un échec d'envoi
(Brevo indisponible) est loggué côté serveur mais **ne change pas** la
réponse HTTP générique renvoyée au client, pour la même raison
anti-énumération que ci-dessus.

## Périmètre : self-service uniquement, pas de réinitialisation par un admin

Ce lot couvre uniquement le cas où l'utilisateur qui a oublié son mot de
passe agit lui-même (le cas rencontré : le titulaire, seul admin). Une
réinitialisation déclenchée par un admin pour le compte d'un tiers
(collaborateur/avocat qui oublie le sien, avec un admin disponible pour
l'aider) n'est **pas** couverte ici — hors scope de la demande initiale,
peut faire l'objet d'un lot séparé si besoin.

## Fichiers livrés

- `backend/prisma/schema.prisma` (modifié — `User.resetCodeHash`,
  `User.resetCodeExpiresAt`, tous deux nullables)
- `backend/prisma/migrations/20260901000000_reset_mot_de_passe/migration.sql`
  (nouveau)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/routes/auth.ts` (modifié — deux nouvelles routes,
  `POST /api/auth/mot-de-passe-oublie` et
  `POST /api/auth/reinitialiser-mot-de-passe`, publiques mais rate-limitées)
- `backend/public/login.html` (modifié — lien "Mot de passe oublié ?" et
  deux formulaires additionnels, cachés par défaut ; le formulaire de
  connexion existant est inchangé)
- Tests : `backend/src/routes/__tests__/auth.motDePasseOublie.test.ts`
  (8 tests, Prisma/mailer mockés)
- `README-LOT20.md` (ce fichier)

## Ce qui a été réellement testé

`tsc --noEmit` propre. `auth.motDePasseOublie.test.ts` (8 tests) : code
généré/haché/envoyé pour un compte existant et actif ; réponse générique
identique pour un compte inconnu (aucun appel Prisma/email déclenché) ;
aucune génération pour un compte désactivé ; réinitialisation réussie avec
le bon code (hash vérifié, mot de passe mis à jour, code consommé) ; rejet
d'un code erroné, d'un code expiré, d'une demande inexistante, et d'un
nouveau mot de passe trop court — dans les quatre cas, aucune écriture en
base.

Suite complète du projet rejouée après ce lot (hors 4 suites e2e
sans rapport, échouées sur timeout de démarrage de cluster Postgres
éphémère en exécution parallèle — confirmées passantes individuellement,
non liées à ce lot).

## Non testé dans cet environnement

- **Réception réelle de l'email** via Brevo (le test unitaire mocke
  `sendEmail`) — à valider manuellement : demander un code depuis
  `login.html` et vérifier sa réception.
- **Le flux complet dans l'appli installée** (poste unique/réseau) : la
  migration s'applique automatiquement au prochain démarrage du backend
  (`applyPendingMigrations.ts`), mais nécessite un nouveau build de
  l'installeur pour atteindre un poste déjà installé — non fait dans ce
  lot (build géré séparément, voir `.github/workflows/build-windows-installer.yml`).
- **Rendu visuel réel** des deux nouveaux formulaires dans `login.html` —
  relu et cohérent avec le style existant de la page, pas cliqué
  manuellement dans un navigateur.
