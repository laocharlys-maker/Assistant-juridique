# Checklist finale — Lot 8 (installeur Windows final)

Document demandé lors de la finalisation du Lot 8, jamais créé jusqu'ici.
Rédigé au moment de la PR [#1](https://github.com/laocharlys-maker/Assistant-juridique/pull/1)
(`lot8ter-retrait-n8n` → `claude/aurore-solution-improvement-rqcjqt`), qui
regroupe tout le travail depuis le Lot 1 jusqu'aux correctifs les plus
récents (Lots 8bis/8ter).

## 1. Résolution des conflits de la PR #1

**Correction d'une erreur d'analyse précédente** : dans mon message
précédent, j'avais annoncé une divergence de ~140 fichiers entre les deux
branches, issue d'une comparaison faite avec une référence locale
obsolète (`origin/claude/aurore-solution-improvement-rqcjqt` non
re-synchronisée avant le calcul du diff). Après un `git fetch` propre :

- `origin/claude/aurore-solution-improvement-rqcjqt` pointe sur le commit
  `786c492` ("feat(nationalite)...").
- Ce commit est un **ancêtre direct** de `lot8ter-retrait-n8n`
  (`git merge-base --is-ancestor` confirme, GitHub confirme aussi :
  `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN`).
- Les trois fonctionnalités propres à la branche cible que je pensais
  menacées (champ Nationalité, message d'accueil adapté à l'heure sur le
  tableau de bord, bouton Échéances) sont en réalité **déjà incluses**
  dans `lot8ter-retrait-n8n` — vérifié directement dans l'arborescence de
  travail (`nouvelle-action.html`, `tableau-de-bord.html`).

**Conclusion : aucun fichier n'a nécessité d'arbitrage.** Il n'y a aucun
conflit réel à résoudre — `lot8ter-retrait-n8n` contient déjà 100% de
`claude/aurore-solution-improvement-rqcjqt` plus tout le travail desktop
(Lots 1 à 8ter). La règle de tri demandée (infra desktop vs fonctionnalités
métier vs fusion vs ambigu) ne s'applique à aucun fichier dans ce cas
précis.

## 2. Les 5 livrables du prompt initial du Lot 8

| Livrable | Statut |
|---|---|
| Config bundle NSIS dans `tauri.conf.json` | ✅ Fait — validé par un build CI réel réussi (Rust + Tauri + NSIS) |
| Écran de bienvenue post-installation (bienvenue → choix du mode → activation licence) | ✅ Fait — parcours testé de bout en bout en conditions réelles (voir README-LOT8.md) |
| Désinstalleur avec choix explicite conserver/supprimer les données | ✅ Fait (`installer/nsis/installer-hooks.nsh`, `NSIS_HOOK_PREUNINSTALL`) — ⚠️ À vérifier : le choix conserver/supprimer lui-même n'a pas de confirmation de test réel documentée dans cette conversation, seul le correctif du fichier verrouillé (Lot 8ter) a été validé par un build CI réussi |
| Auto-update avec confirmation native obligatoire (`updater.rs`, tout en Rust) | ✅ Écrit (vérification en arrière-plan, boîte de dialogue native avant tout téléchargement) — clé publique réelle et endpoint désormais opérationnels (voir section 4, résolu le 2026-08-05) ; manifeste + signature vérifiés accessibles en conditions réelles — ⚠️ reste à tester : le déclenchement effectif d'une mise à jour par une app déjà installée (nécessite deux versions distinctes, jamais encore le cas) |
| Documentation utilisateur (`docs-utilisateur/`, 5 guides sans jargon) | ✅ Fait — ⚠️ Captures d'écran encore des emplacements marqués `[Capture d'écran : ...]` dans 01, 02, 03 et 05 |

## 3. Reste à faire avant de fusionner (liste `STATUS.md`, 2026-08-03)

| Critère | Statut |
|---|---|
| Confirmation utilisateur que l'app installée démarre normalement (double-clic, pas ligne de commande) | ✅ Fait — confirmé implicitement par les nombreux cycles de test réel menés depuis (installation, connexion, génération de documents, etc.) |
| Test du parcours de désinstallation (conservation ET suppression des données) | ⚠️ À vérifier — jamais explicitement confirmé dans cette conversation |
| Voir liste "À faire avant toute distribution réelle" (README-LOT8.md) | Voir section 4 ci-dessous |
| Fusionner dans `claude/aurore-solution-improvement-rqcjqt` une fois validé | ⏳ En attente de votre validation (PR #1 ouverte, prête, aucun conflit) |

## 4. À faire avant toute distribution réelle à un cabinet (README-LOT8.md)

| Critère | Statut |
|---|---|
| Déclencher le workflow GitHub Actions au moins une fois et corriger les échecs | ✅ Fait — de nombreux builds CI réussis tout au long des Lots 8/8bis/8ter |
| Ajouter le téléchargement/compilation des binaires PostgreSQL portables au workflow | ✅ Fait — étape dédiée présente et fonctionnelle |
| **Clé API IA de production** | ✅ Fait — décision tranchée (option a : secrets GitHub partagés). `GROQ_API_KEY` (génération de texte), `TAVILY_API_KEY` (recherche web), `SMTP_HOST`/`SMTP_USER`/`SMTP_PASSWORD` (Brevo) et **`GEMINI_API_KEY`** (embeddings RAG jurisprudence, ajoutée le 2026-08-04) sont tous configurés et confirmés injectés en CI (`GEMINI_API_KEY injectee : True`) |
| Générer la vraie paire de clés de signature updater, remplacer le placeholder | ✅ Fait (2026-08-05) — générée via un workflow CI ponctuel (`generate-updater-key.yml`, le CLI Tauri n'est disponible que là) ; clé privée + mot de passe stockés en secrets GitHub (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, jamais passés en clair dans un log, artefact de transfert supprimé après récupération) ; clé publique câblée dans `tauri.conf.json` |
| Héberger un vrai endpoint de mise à jour | ✅ Fait (2026-08-05) — hébergé directement via GitHub Releases (`releases/latest/download/latest.json`), pas d'infrastructure séparée à maintenir. `build-windows-installer.yml` signe désormais l'installeur (`bundle.createUpdaterArtifacts: true`) et publie/actualise automatiquement la release taguée à chaque build réussi. Validé de bout en bout : release `v0.1.0` réelle, manifeste vérifié accessible avec signature correspondante |
| Tester l'installeur sur une VM Windows vierge (snapshot avant/après) | ❌ Manquant — aucun accès VM dans l'environnement de développement ; les tests réels ont été faits sur le poste de travail habituel, pas une machine vierge |
| Faire tester le parcours complet par une personne n'ayant pas participé au développement | ⚠️ À vérifier — selon la définition retenue : vous avez testé le parcours de bout en bout à chaque lot, mais vous avez aussi participé aux décisions produit tout du long |
| Prendre les vraies captures d'écran pour `docs-utilisateur/` | ❌ Manquant — emplacements toujours marqués `[Capture d'écran : ...]` |
| Tester réellement la désinstallation (conservation ET suppression) sur cette VM | ❌ Manquant — dépend du point VM vierge ci-dessus |
| Remplacer la clé publique de licence de test par la vraie clé de production | ❌ Manquant — bloqué sur le Lot 4 (service Cloudflare Workers), jamais commencé, hors périmètre de ce lot |

## 5. Ce qui a été ajouté après la rédaction initiale de README-LOT8.md / STATUS.md (Lots 8bis/8ter)

Pour mémoire, non couvert par les critères d'acceptation originaux mais
livré dans cette même branche :

- Correctif du blocage de statut de document en desktop (racine : ancien
  callback n8n jamais appelé en poste unique) — voir `backend/README-LOT8TER.md`.
- Retrait complet de la dépendance n8n (WhatsApp, lien Google Docs,
  rappels Calendar) ; emails portés vers Brevo/Nodemailer.
- Onglets Délais, page Types de délais reorganisée, message d'erreur
  clarifié pour l'indexation de jurisprudence.
- Confirmation de téléchargement (toast) sur les exports Word/PDF de la
  fiche dossier, libellé de retour corrigé sur la page Recherche,
  audiences programmées visibles par tous les avocats du cabinet.
- Correctif installeur : fermeture d'Aurore avant install/désinstall pour
  éviter un fichier verrouillé (`query_engine-windows.dll.node`).

## 6. Résumé — ce qui bloque encore une distribution réelle

~~Clé de signature updater~~ et ~~endpoint de mise à jour réel~~ résolus
le 2026-08-05 (voir section 4). Trois points restent, tous indépendants
du code applicatif lui-même :

1. Test sur VM Windows vierge → nécessite un accès VM.
2. Vraies captures d'écran → à prendre une fois un installeur final entre
   les mains.
3. Clé de licence de production → bloqué sur le Lot 4 (non commencé).

Aucun de ces points ne concerne le code fusionné dans cette PR — ce sont
des étapes opérationnelles à mener séparément, avant une vraie mise à
disposition à des cabinets clients.
