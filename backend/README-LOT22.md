# Lot 22 — Registre de modèles LLM à distance + repli automatique

Avant ce lot, les noms de modèles (Gemini, Anthropic, Groq) étaient des
constantes codées en dur dans `services/llm/gemini.ts`/`anthropic.ts`/
`groq.ts`. Un fournisseur qui retire ou renomme un modèle (déjà arrivé côté
Groq/Llama) exigeait un nouveau build **et** une réinstallation manuelle chez
chaque cabinet via l'auto-updater Tauri (Lot 8) — Aurore est un logiciel
desktop installé indépendamment par cabinet, jamais un SaaS centralisé.

Deux mécanismes indépendants, l'un n'a pas besoin de l'autre :

1. **Repli local automatique** (toujours actif, y compris hors connexion) —
   fonctionne dès aujourd'hui, sans aucune dépendance externe.
2. **Configuration distante via phone-home** (nécessite le code de ce lot
   déployé sur `aurore-licence-service` — **pas encore fait**, voir section
   "Dépendance non résolue" ci-dessous, **corrigée le 2026-08-16** : le
   Worker de base est en réalité déployé en production depuis le 2026-08-05,
   contrairement à ce qu'affirmait la version précédente de cette section)
   — permet à AzoMedIA de changer le modèle actif pour tous les cabinets
   sans redéploiement ni réinstallation, une fois le code de ce lot déployé.

## 1. Registre centralisé (`services/llm/registreModeles.ts`)

Un modèle **principal** et un modèle de **repli** par fournisseur, avec des
valeurs par défaut codées en dur (état au 2026-08-16) :

| Fournisseur | Principal              | Repli                        |
|-------------|-------------------------|-------------------------------|
| gemini      | `gemini-3.6-flash`      | `gemini-2.5-flash`            |
| anthropic   | `claude-sonnet-5`       | `claude-haiku-4-5-20251001`   |
| groq        | `llama-3.3-70b-versatile` | `llama-3.1-8b-instant`      |

Le modèle de **repli n'est jamais modifiable à distance** — c'est le filet de
sécurité qui doit rester valide même sans connexion ni service de licence
déployé. Si un fournisseur venait à le retirer aussi, seule une mise à jour de
ce fichier (nouveau build) peut le corriger — c'est un choix assumé : le
mécanisme distant (point 2) ne remplace jamais la nécessité de revoir
périodiquement ces valeurs par défaut.

`gemini.ts`/`anthropic.ts`/`groq.ts` lisent désormais le modèle à appeler via
ce registre (`getModelePrincipal`) plutôt qu'une constante locale.

## 2. Repli automatique (`appelerAvecRepli`)

Chaque appel fournisseur (`extractAction`/`redact`) passe par
`appelerAvecRepli(fournisseur, appel)` :

1. Essaie le modèle **principal**.
2. Si l'échec est **caractéristique d'un modèle retiré/renommé**
   (`isErreurModeleIndisponible`) — statut HTTP 404 ou 400 **et** un motif
   textuel du type "not found"/"does not exist"/"model_decommissioned" — 
   retente **une seule fois** avec le modèle de **repli** du même
   fournisseur. Un avertissement est loggé (`[registreModeles] modele "X"
   indisponible pour {fournisseur} (...) - repli automatique sur "Y"`),
   visible même si l'avocat n'a rien remarqué.
3. Toute autre erreur (clé API invalide — 401/403 —, quota épuisé — 429 —,
   panne réseau transitoire déjà gérée par `withTransientRetry` en amont...)
   est **propagée immédiatement, sans repli** — le contrat explicite de ce
   lot est de ne jamais masquer une vraie erreur de clé/quota derrière un
   changement de modèle.

Ce mécanisme fonctionne **intégralement hors ligne** : il ne dépend d'aucun
service externe, seulement des valeurs par défaut codées en dur ou d'un cache
distant déjà reçu (point 3).

## 3. Configuration distante (phone-home, `aurore-licence-service`)

Le service de licence (dépôt séparé `aurore-licence-service`) reçoit un champ
optionnel `modelesLlmActifs` dans la réponse `/phone-home` nominale
(`src/routes/phoneHome.ts`), lu depuis une nouvelle table D1 :

```sql
CREATE TABLE IF NOT EXISTS modeles_llm_actifs (
  provider TEXT PRIMARY KEY,        -- 'gemini' | 'anthropic' | 'groq'
  modele TEXT NOT NULL,
  actif INTEGER NOT NULL DEFAULT 1,
  date_maj TEXT NOT NULL
);
```

- Si la table est vide, le champ `modelesLlmActifs` est **omis** de la
  réponse (jamais un objet vide) — le client garde alors sa configuration
  locale actuelle.
- Toute erreur de lecture de cette table est absorbée (best-effort, comme la
  journalisation `phone_home_log` existante) : elle ne peut jamais empêcher
  la réponse de licence normale.

Côté client (`security/licenceManager.ts`), `phoneHomeResponseSchema` (zod)
déclare désormais `modelesLlmActifs: z.record(z.string()).optional()`, **non
strict** comme le reste de ce schéma : un ancien client qui ne connaît pas ce
champ l'ignore de toute façon (comportement zod par défaut, déjà vérifié pour
ce schéma avant ce lot), et un ancien serveur qui ne l'envoie pas ne casse
rien côté client (`.optional()`). Quand le champ est présent dans une réponse
phone-home réussie, `registreModeles.appliquerConfigurationDistante()` est
appelée et met à jour le modèle **principal** de chaque fournisseur listé (le
repli reste toujours celui codé en dur). Le cache est **persisté sur disque**
(`%APPDATA%/Aurore/secrets/registre-modeles-distant.json`) pour survivre à un
redémarrage sans connexion — voir point 4.

## 4. Mode licence "manuel"

Aucune logique nouvelle n'a été nécessaire : `runPhoneHomeCheck()` posait déjà
la garde "zéro appel réseau en mode manuel" avant ce lot
(`status.payload.modeVerification !== "auto" && !options.force`), et
`appliquerConfigurationDistante()` n'est appelée qu'**après** avoir reçu une
réponse HTTP — donc jamais en mode manuel sans action explicite de
l'utilisateur (bouton "Vérifier maintenant", `force: true`, déjà la seule
exception préexistante pour la licence elle-même). En mode manuel, le
registre reste figé sur les valeurs codées en dur **ou** le dernier cache
distant connu (persisté sur disque, point 3) — jamais bloqué en attente d'un
réseau indisponible.

## ⚠️ Dépendance non résolue (mise à jour 2026-08-16 — corrige une affirmation fausse de ce fichier)

**Cette section affirmait initialement que `aurore-licence-service` n'était
« jamais déployé sur Cloudflare ». C'était faux au moment où c'était écrit**
(l'information venait de `README.md` de ce dépôt, lui-même resté obsolète
après un déploiement réussi le jour même — voir ce fichier, section "Non
testé", corrigée en parallèle de celle-ci). Vérifié en direct le 2026-08-16 :

- Le Worker **est bien déployé en production** depuis le 2026-08-05
  (`wrangler deployments list`), à
  `https://aurore-licence-service.azomedia20.workers.dev`.
- La base D1 `aurore_licences` (remote) contient de **vraies données** de
  production : 2 cabinets, 2 licences (pas seulement le schéma).
- Un appel réel à `POST /phone-home` (cabinet de production existant) répond
  correctement, et sa signature **vérifie avec succès** contre la clé
  publique embarquée dans `config/licencePublicKey.ts` — ce n'est donc plus
  le placeholder de test, c'est bien la clé de production.

**Ce qui reste réellement non résolu**, en revanche : le Worker actuellement
en ligne tourne sur le code **d'avant ce Lot 22** — la migration
`modeles_llm_actifs` (section 3 ci-dessus) n'a jamais été appliquée à la base
D1 remote (`npm run d1:schema:remote` non exécuté depuis son ajout), et le
`phoneHome.ts` modifié par ce lot n'a jamais été redéployé
(`wrangler deploy`). Un appel réel à `/phone-home` aujourd'hui **ne renvoie
donc pas** le champ `modelesLlmActifs` (vérifié : réponse `{"licence":
{"payload":{...},"signature":"..."}}`, sans ce champ).

**Conséquence concrète pour ce lot** : les points 3 et 4 ci-dessus
(configuration distante) sont fonctionnels et testés **en local uniquement**
— aucun cabinet réel ne reçoit aujourd'hui de configuration distante, non pas
parce que le service de licence n'existe pas, mais parce que **ce lot n'a pas
encore été déployé dessus**. **Seuls les points 1 et 2 (repli local
automatique) protègent réellement les cabinets pour l'instant** — même
conclusion que la version précédente de ce fichier, mais pour une raison
différente et beaucoup plus facile à lever (un déploiement, pas un compte
Cloudflare à créer).

Ce lot n'a **pas** cherché à déployer ces changements (hors périmètre d'une
tâche "n'implémente que le code, sans redéployer un service tiers en
production sans confirmation explicite") : le code est prêt et testé, il
attend uniquement l'exécution de la procédure ci-dessous.

## Procédure AzoMedIA — pour activer la configuration distante de ce lot

1. Le service tourne déjà en production (`https://aurore-licence-service.
   azomedia20.workers.dev`, vérifié le 2026-08-16) — appliquer uniquement la
   migration puis redéployer le code de ce lot :
   ```
   npm run d1:schema:remote   # applique src/db/schema.sql, idempotent (IF NOT EXISTS) -
                               # crée modeles_llm_actifs sans toucher aux donnees existantes
   npm run deploy              # publie le phoneHome.ts mis a jour (champ modelesLlmActifs)
   ```
2. Pour changer le modèle actif d'un fournisseur pour **tous les cabinets
   connectés** (mode licence "auto", au prochain phone-home hebdomadaire ou
   au prochain démarrage) :
   ```sql
   INSERT INTO modeles_llm_actifs (provider, modele, actif, date_maj)
   VALUES ('groq', 'nouveau-nom-du-modele', 1, '2026-08-16T00:00:00.000Z')
   ON CONFLICT(provider) DO UPDATE SET
     modele = excluded.modele,
     actif = excluded.actif,
     date_maj = excluded.date_maj;
   ```
   Exécutable depuis le dashboard Cloudflare D1 (console SQL) ou :
   ```
   wrangler d1 execute aurore_licences --remote --command "..."
   ```
   **Aucun redéploiement du Worker ni réinstallation cabinet requis.**
3. Pour désactiver une entrée distante et laisser les cabinets retomber sur
   leur valeur par défaut codée en dur : `UPDATE modeles_llm_actifs SET
   actif = 0 WHERE provider = '...'` (une ligne `actif = 0` n'est jamais
   renvoyée par `phoneHome.ts`, qui filtre `WHERE actif = 1`).
4. Les cabinets en mode licence "manuel" ne recevront cette mise à jour
   qu'en cliquant explicitement "Vérifier maintenant" (aucun appel réseau
   automatique, voir point 4) — communiquer ce point si un changement de
   modèle est urgent pour un cabinet en mode manuel.
5. Le modèle de **repli** (filet de sécurité local) n'est jamais modifié par
   cette procédure — s'il devient lui-même invalide, seule une mise à jour de
   `registreModeles.ts` (nouveau build + réinstallation) le corrige.

## Fichiers modifiés/ajoutés

- `backend/src/services/llm/registreModeles.ts` (nouveau)
- `backend/src/services/llm/gemini.ts`, `anthropic.ts`, `groq.ts`
- `backend/src/security/licenceManager.ts`
- `aurore-licence-service/src/db/schema.sql`
- `aurore-licence-service/src/routes/phoneHome.ts`
- Tests : `backend/src/services/llm/__tests__/{registreModeles,gemini,groq}.test.ts`,
  `anthropic.test.ts` (complété), `backend/src/security/__tests__/
  licenceManager.test.ts` (nouveau), `aurore-licence-service/src/routes/
  phoneHome.test.ts` (nouveau)

Note d'implémentation : le prompt initial visait `server/src/services/llm/`
— ce chemin n'existe pas dans ce dépôt, le code du backend vit sous
`backend/src/services/llm/`. Le registre a été créé à cet emplacement réel.
