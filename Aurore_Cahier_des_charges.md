# Aurore — Assistant Juridique IA
## Cahier des charges — Évolution v3 (arbitrages architecture)

**Client :** Cabinet KOFFI & ASSOCIES
**Prestataire :** AzoMedIA
**Statut actuel :** Aurore v1 mise à l'arrêt (workflow n8n conservé comme référence, non actif en prod)
**Objectif de ce document :** brief de travail exhaustif pour reprise en développement (Claude Code)

---

## 1. Existant — état des lieux

### 1.1 Ce qui fonctionnait dans la v1

Aurore v1 était un workflow n8n déclenché par WhatsApp (numéro de test Meta), avec un unique AI Agent (Google Gemini) qui routait vers 3 actions selon le contenu du message reçu : compte-rendu d'audience, rédaction de plaidoirie, recherche de jurisprudence. Sorties : Google Docs, PDF, Gmail, Google Calendar, Google Sheets.

**Outils IA connectés à l'agent :** Google Gemini (LLM + transcription vocale), Tavily (recherche web).

### 1.2 Limites identifiées à corriger

1. Numéro WhatsApp de test Meta — instable, non pérenne.
2. Extraction de données par IA sur texte libre uniquement — champs "Non précisé" fréquents.
3. Sortie de l'agent en JSON texte, parsée par une regex maison (`Code in JavaScript`) — point de rupture fragile déjà à l'origine de bugs documentés ("Bad control character").
4. Recherche juridique limitée à Tavily (web générique) — pas de base dédiée au droit béninois/OHADA.
5. Mono-utilisateur — pas de comptes, pas de séparation des dossiers par collaborateur.
6. Pas d'interface visuelle — tout passe par WhatsApp.
7. Pas de mémoire de dossier persistante.
8. Pas de gestion d'erreur ni de logs d'audit visibles.
9. Toute la logique métier (routage, validation, extraction) vit dans n8n — difficile à tester, à versionner, à faire évoluer sans casser les nœuds Switch en aval.

---

## 2. Objectif de la v2/v3

Transformer Aurore d'un **bot WhatsApp mono-utilisateur** en une **plateforme cabinet multicanale et multi-collaborateurs**.

### Principe directeur (mis à jour)

WhatsApp devient un canal parmi d'autres ; le produit devient une **application web** (backend Node/Express + PostgreSQL) qui porte toute la logique métier et l'orchestration IA. **n8n est conservé, mais recentré sur son rôle de couche d'intégration** (connecteurs Google Workspace, canal WhatsApp, tâches planifiées) — il n'est plus le cerveau du système, il exécute des actions déclenchées par le backend.

---

## 3. Architecture cible (révisée)

```
┌─────────────────────────┐     ┌──────────────────────────┐
│   App web (PC/mobile)   │     │   WhatsApp (Evolution API) │
│   Formulaires structurés │     │   Vocal / texte libre       │
└────────────┬─────────────┘     └──────────────┬───────────────┘
             │                                   │
             ▼                                   ▼
     ┌──────────────────────────────────────────────────┐
     │        BACKEND (Node/Express + PostgreSQL)          │
     │  — Auth, rôles, dossiers, historique                 │
     │  — Orchestration IA (Gemini, structured output)      │
     │  — Validation post-extraction                        │
     │  — RAG jurisprudence (pgvector)                      │
     │  — Calcul de délais de procédure (déterministe)      │
     │  — Audit logs                                        │
     └───────────────────┬────────────────────────────────┘
                          │  Webhook HTTP (actions déjà validées)
                          ▼
                  ┌───────────────┐
                  │      n8n       │   ← couche d'intégration uniquement
                  │ (orchestrateur │
                  │  d'exécution)  │
                  └───────┬────────┘
                          ▼
              ┌────────────────────────────┐
              │  Google Workspace              │
              │  Docs · Calendar · Sheets ·   │
              │  Gmail · WhatsApp (Evolution) │
              └────────────────────────────┘
```

**Répartition des responsabilités :**
- Le **backend** décide, valide, extrait, génère le texte, calcule — c'est la seule source de vérité métier.
- **n8n** exécute des effets de bord déjà décidés (écrire dans un Doc, envoyer un mail, poser un événement Calendar, répondre sur WhatsApp) — plus de logique de décision dans n8n.
- Entrée **formulaire web** → JSON déjà structuré → le backend appelle l'IA uniquement pour la rédaction.
- Entrée **WhatsApp** → le backend reçoit le texte/vocal transcrit via n8n, extrait avec sortie IA structurée (function calling, schéma validé), valide, puis déclenche n8n pour les effets de bord.

---

## 4. Fonctionnalités à développer

### 4.1 Canal WhatsApp
- [ ] Migration vers Evolution API (auto-hébergé Railway), numéro Business dédié, warm-up progressif
- [ ] n8n reçoit le webhook Evolution API et relaie au backend (texte transcrit ou texte brut) — plus d'extraction/routage dans n8n
- [ ] Transcription vocale (Gemini) déclenchée par n8n, résultat transmis au backend

### 4.2 Application web (cœur du produit)
**Stack :** Node.js + Express (backend), PostgreSQL, dashboard HTML/JS (React seulement si la complexité UI le justifie plus tard).

- [ ] Authentification (email + mot de passe hashé, sessions/JWT)
- [ ] Rôles `avocat_titulaire` / `collaborateur`, `cabinet_id` pour usage multi-cabinets futur
- [ ] Formulaires structurés par action (CR d'audience, plaidoirie, jurisprudence, conclusions, mise en demeure)
- [ ] Soumission formulaire → traitement direct par le backend (pas d'étape d'extraction IA)
- [ ] Dashboard de pilotage (dossiers actifs, CR générés, échéances, temps gagné estimé)
- [ ] Historique par dossier (CR, plaidoiries, recherches, rendez-vous)
- [ ] Filtrage "mes dossiers" vs "vue cabinet"

### 4.3 Fiabilité (prioritaire, Phase 1)
- [ ] Sortie IA en structured output / function calling avec schéma validé côté backend (zod ou équivalent) — suppression du parsing JSON par regex
- [ ] Validation post-extraction : blocage + demande de précision si champ critique manquant, avant génération du document
- [ ] Base RAG jurisprudence dédiée (PostgreSQL + pgvector) : Code béninois, décisions OHADA/CCJA, interrogée avant Tavily
- [ ] Citation systématique et vérifiable des sources (référence exacte) ; l'agent doit dire "source non trouvée" plutôt qu'inventer une jurisprudence
- [ ] Mémoire de dossier persistante (table PostgreSQL, contexte des échanges précédents)
- [ ] Gestion d'erreurs avec notification claire à l'utilisateur (WhatsApp ou app), plus d'échec silencieux
- [ ] Logs d'audit (qui, quoi, quand, résultat), consultables depuis l'app
- [ ] Environnement de test n8n séparé de la prod avant toute mise en ligne

### 4.4 Nouvelles fonctionnalités juridiques
- [ ] Rédaction de conclusions, assignations, mises en demeure (même schéma structuré que la plaidoirie)
- [ ] Résumé de jurisprudence longue (upload PDF 10-20 pages → fiche synthétique, avec découpage si document trop long)
- [ ] Veille juridique automatique hebdomadaire (digest lundi matin)
- [x] Calcul de délais de procédure — module déterministe (pas d'IA), création automatique du rappel Calendar. Le cabinet saisit lui-même les délais réels (nombre + texte de loi) dans un référentiel dédié ; aucune valeur n'est devinée par l'IA.
- [ ] Traduction juridique FR ↔ EN (avec relecture humaine requise avant envoi)

### 4.5 Fonctionnalités "cabinet" (Phase 4)
- [ ] Facturation / suivi des honoraires, relance automatique — Mobile Money (MTN MoMo / Moov) en priorité, Stripe en option
- [ ] Portail client léger (lien signé à durée limitée, lecture seule, scellé à un dossier)
- [ ] Dashboard analytics avancé (volume de CR/mois, répartition par type d'action, dossiers en attente)

### 4.6 Sécurité & conformité *(nouveau)*
- [ ] Chiffrement au repos des données sensibles
- [ ] Politique de rétention des données
- [ ] Clause explicite d'information sur le passage des données par un LLM tiers (Gemini)
- [ ] Rate limiting / anti-abus sur les webhooks entrants (WhatsApp, formulaires)

---

## 5. Modèle de données

```
cabinets
  id, nom, created_at

users
  id, cabinet_id (FK), nom, email, mot_de_passe_hash, role (titulaire/collaborateur), created_at

dossiers
  id, cabinet_id (FK), numero_dossier, nom_affaire, nom_client, nom_juge,
  created_by (FK users), statut, created_at, updated_at

actions
  id, dossier_id (FK), type_action (notes/redac/jurisprudence/conclusions/assignation/mise_en_demeure),
  canal (web/whatsapp), contenu_genere, date_audience, prochaine_audience,
  pieces_prevoir, created_by (FK users), created_at

audit_logs
  id, action_id (FK), etape, statut (succes/erreur), detail, timestamp

jurisprudence_chunks
  id, source, reference, contenu, embedding (vector), created_at
```

---

## 6. Stack technique

| Composant | Choix |
|---|---|
| Backend / orchestration métier & IA | Node.js + Express |
| Base de données | PostgreSQL (+ pgvector pour le RAG) |
| Intégration WhatsApp + Google Workspace | n8n (rôle recentré : exécution d'effets de bord uniquement) |
| WhatsApp | Evolution API (auto-hébergé sur le VPS du cabinet) |
| LLM (extraction / rédaction / recherche) | Groq (gratuit, Llama 3.3 70B) pour le développement — quota Gemini gratuit constaté à 0 sur le projet Google actuel ; bascule possible vers Gemini ou Claude (Anthropic) en production via `LLM_PROVIDER` — sortie structurée validée par schéma dans les trois cas |
| Transcription vocale WhatsApp | Google Gemini, conservé côté n8n indépendamment du fournisseur choisi ci-dessus |
| Recherche web complémentaire | Tavily |
| Stockage documents | Google Workspace (Docs, Sheets, Calendar, Drive) |
| Email | Gmail SMTP (via n8n ou API directe) |
| Frontend | HTML/JS (dashboard + formulaires), migration React si besoin |
| Hébergement | VPS Hostinger (Ubuntu 22.04) |

---

### 6.1 Déploiement HTTPS du backend

Le backend est accessible en production sur `https://aurore.srv1300783.hstgr.cloud`,
via le même conteneur Traefik que n8n (`/docker/n8n/docker-compose.yml`), plutôt
que via nginx (déjà occupé par un autre projet du VPS, et en conflit avec Traefik
sur les ports 80/443).

**Principe :** Traefik route `aurore.srv1300783.hstgr.cloud` vers le backend qui
tourne directement sur l'hôte (port 3001, hors Docker), via une configuration
dynamique par fichier plutôt que des labels Docker (le backend n'étant pas
conteneurisé) :
- `/docker/n8n/dynamic/aurore.yml` : déclare le routeur Traefik (règle de host,
  certificat Let's Encrypt via le même `certresolver` que n8n) et le service
  cible `http://host.docker.internal:3001`
- `docker-compose.yml` (service `traefik`) : ajout de `extra_hosts:
  host.docker.internal:host-gateway` et du provider `--providers.file.directory`
  pour lire ce fichier

**Piège rencontré (à retenir)** : `host-gateway` résout systématiquement vers
l'IP du réseau `bridge` par défaut de Docker (`172.17.0.1`), **même si** le
conteneur Traefik tourne sur un réseau Compose dédié (`n8n_default`,
`172.18.0.0/16` dans notre cas). Le pare-feu (`ufw`) doit donc autoriser le port
3001 depuis toute la plage privée Docker (`172.16.0.0/12`), pas seulement le
sous-réseau du conteneur — sinon la requête time-out silencieusement (paquet
DROP, pas de refus explicite, difficile à diagnostiquer).

**Si le backend est un jour conteneurisé**, remplacer cette configuration par
des labels Traefik directs sur son conteneur (comme pour `n8n`), et supprimer
le fichier `dynamic/aurore.yml` ainsi que la règle ufw associée.

---

## 7. Priorisation

**Phase 0 — Fondations**
- Repo, schéma PostgreSQL, squelette backend Express
- n8n existant mis à l'arrêt, conservé comme référence versionnée

**Phase 1 — Fiabilisation**
- Migration Evolution API + numéro dédié
- Sortie IA structurée + validation post-extraction
- Gestion d'erreurs / fallback, logs d'audit

**Phase 2 — App web + multi-collaborateurs**
- Authentification, rôles, modèle de données
- Formulaires structurés, dashboard de base, historique par dossier

**Phase 3 — Renforcement juridique**
- Base RAG jurisprudence
- Nouvelles actions (conclusions, mise en demeure, assignation, résumé PDF)
- Calcul de délais de procédure

**Phase 4 — Extensions business**
- Veille juridique automatique
- Facturation, portail client, traduction, analytics avancé

---

## 8. Notes pour la reprise en développement

- Le fichier `Solution_Assistant_Juridique_NEW__1_.json` (export n8n v1, 28 nœuds) est conservé dans le repo comme référence historique, pas comme base à faire évoluer telle quelle : la logique de routage/extraction qu'il contient migre vers le backend.
- Le format de sortie structuré de l'IA doit rester strict (schéma validé), pour permettre au backend de router fiablement vers les bonnes actions.
- Ne jamais donner de prix ferme au client sans diagnostic préalable — ce document est un cahier des charges technique, pas une proposition commerciale chiffrée.
