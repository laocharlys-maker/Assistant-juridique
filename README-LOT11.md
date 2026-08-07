# Lot 11 : documents partagés séquentiels + validation qui s'impose + mode rédaction libre

Trois volets livrés ensemble : (A) verrouillage séquentiel + historique de
versions + validation qui s'impose, (B) mode de création "rédaction libre"
en alternative à la génération IA, (C) avertissement à l'export Word/PDF +
cohérence visuelle de l'éditeur. Prérequis (Lot 10, remarques de révision)
mergé au préalable dans `claude/aurore-solution-improvement-rqcjqt`.

---

## Partie A — Verrouillage séquentiel, versions, validation qui s'impose

### Fonctionnement du verrouillage

- `Action.verrouillePar` (id utilisateur) / `Action.verrouilleLe` (date de
  prise) : `POST /api/actions/:id/verrou` prend le verrou s'il est libre,
  déjà détenu par soi-même, ou expiré. Sinon `409` avec un message clair :
  *"Ce document est en cours de modification par [nom] depuis [heure]."*
- `DELETE /api/actions/:id/verrou` ("Terminer l'édition") le libère
  explicitement - jamais dépendant de la seule fermeture d'onglet.
- Un document `valide`/`envoyé` ne peut plus être rouvert en édition
  directement (`409`) - il faut d'abord une remarque de révision (Lot 10,
  `revision_demandee`) pour repasser le cycle en amont.

### Politique de timeout retenue

`VERROU_TIMEOUT_HEURES` (variable d'environnement, **4h par défaut**).
Un verrou plus ancien que ce délai est considéré abandonné :
- il peut être repris immédiatement par quiconque tente `POST /verrou`
  (vérifié à la volée, sans attendre le job) ;
- il est aussi libéré activement toutes les 30 minutes par
  `src/jobs/liberationVerrousExpires.ts` (`node-cron`, même mécanisme que
  les autres jobs planifiés du projet - phone-home licence, veille
  juridique, retention - voir `src/index.ts`), avec un log de l'événement.

### Historique de versions

`POST /api/actions/:id/versions` (réservé à qui détient le verrou, voir
`middleware/verifierVerrou.ts`) crée une nouvelle `ActionVersion` à chaque
sauvegarde **explicite** ("Enregistrer") - jamais d'autosave en continu.

**Point de conception important, à bien comprendre** : `Action.contenuGenere`
reflète **toujours la dernière version validée**, jamais la dernière version
simplement enregistrée. Sauvegarder une version n'écrit donc jamais
`contenuGenere` - seule une validation explicite d'une version précise
(`POST /api/actions/:id/versions/:versionId/valider`) le fait, en même temps
qu'elle bascule `Action.statut` à `valide`. Conséquence directe :
`documentExport.ts`/`documentFormalisme.ts` n'ont **subi aucune
modification** de leur logique - ils continuent de lire `contenuGenere` sans
rien savoir de l'existence des versions.

Autres règles :
- Jamais un collaborateur ne peut valider une version (`403`).
- Bloquée (`409`) tant qu'il reste des `CommentaireRevision` "ouvert" sur le
  document - même garde que le Lot 10, réappliquée ici pour la validation
  par version.
- Historique jamais supprimé, même les versions remplacées - traçabilité en
  cas de litige (même raisonnement que les commentaires de révision).

### Articulation avec le Lot 10

Le cycle de statut du Lot 10 (`en_attente_validation ⇄ revision_demandee`)
et celui de la Partie A (verrou/version) sont **indépendants mais
compatibles** : une remarque de révision peut être laissée à tout moment
tant que le document n'est pas `valide`, y compris pendant un cycle de
versions en cours ; et la validation d'une version (Partie A) applique la
**même** garde "aucune remarque ouverte" que l'ancienne route générique de
validation.

**Décision prise pour éviter toute ambiguïté** : dès qu'au moins une
`ActionVersion` existe pour un document (`versionActuelle > 0`), l'ancienne
route générique `POST /api/actions/:id/valider` (Lot 10) est bloquée
(`409` : *"Ce document utilise l'historique de versions : valide une
version précise depuis l'onglet Historique."*). Elle reste pleinement
fonctionnelle pour tout document jamais entré dans le cycle verrou/version
(cas le plus courant : documents validés sans jamais être réédités).

**Retrait de `PATCH /api/actions/:id/contenu`** : cette route (correction
directe du texte, sans aucune vérification de verrou, modifiable même sur un
document déjà `valide`) permettait de contourner entièrement le système de
verrou/version/validation qui s'impose. Elle a été retirée - remplacée par
`POST /api/actions/:id/versions`, seule voie d'édition désormais.

### Limite assumée

Aucune traçabilité une fois le document édité **en dehors** d'Aurore (Word
téléchargé puis modifié dans Word, par exemple) - voir Partie C, mesure
d'atténuation par la mention d'avertissement, pas une garantie technique.

---

## Partie B — Mode de création : rédaction libre

`Action.modeCreation` (`"genere_ia"` par défaut | `"redaction_libre"`),
jamais modifié après création. Nouvel écran de choix explicite sur
"Nouvelle action" (avant tout formulaire) : **Générer avec l'IA** (chemin
existant, strictement inchangé) ou **Rédiger librement**.

En mode rédaction libre : `POST /api/actions/redaction-libre`, seuls le type
de document et le nom du client sont obligatoires (numéro de dossier/nom de
l'affaire optionnels, comme plusieurs formulaires IA existants) - aucun
appel LLM, aucune pseudonymisation, `champsDocument` reste `null`.
`contenuGenere` est initialisé avec le gabarit statique du type choisi (voir
`services/gabaritsRedactionLibre.ts`), puis édité librement via le **même**
cycle verrou/version de la Partie A (aucune branche conditionnelle sur le
mode de création dans cette logique).

### Gabarits statiques disponibles (les 16 types existants)

| Type | Gabarit |
|---|---|
| `notes` | Titre "Compte-rendu d'audience" |
| `redac` | Formule d'ouverture "Pour le compte de..." + clôture "Par ces motifs..." |
| `conclusions` | En-tête "CONCLUSIONS" (Pour/Contre) + "PAR CES MOTIFS" |
| `note_plaidoirie` | Titre "NOTE DE PLAIDOIRIE" |
| `assignation` | "DONNE ASSIGNATION À :" + "PAR CES MOTIFS" |
| `mise_en_demeure` | "Maître," + formule de politesse |
| `plainte` | "Monsieur le Procureur de la République," + formule de politesse |
| `contrat` | En-tête "CONTRAT" + "Entre les soussignés :" |
| `notification_date` | "Madame, Monsieur," + formule de politesse |
| `requete` | Titre "REQUÊTE" + "À Madame/Monsieur le Président," + clôture |
| `projet_ordonnance` | Titre "PROJET D'ORDONNANCE" |
| `jurisprudence` | Titre "Recherche de jurisprudence" |
| `recherche_juridique` | Titre "Recherche juridique" |
| `resume_pdf` | Titre "Résumé" |
| `veille_juridique` | Titre "Veille juridique" |
| `traduction` | Titre "Traduction" |

Référentiel statique en dur (`GABARITS_REDACTION_LIBRE`, pas une table en
base) - suffisant pour cette V1, pas d'admin UI pour l'éditer.

**Décision** : la liste des 16 types proposée en rédaction libre reprend le
référentiel complet `TYPE_LABELS` (dont `veille_juridique`, normalement
généré automatiquement chaque lundi) plutôt que les 15 types du catalogue
"Nouvelle action" habituel - rien n'empêche un avocat de rédiger lui-même un
bulletin de veille hors du cycle automatique.

### `documentExport.ts` sans `champsDocument`

**Vérifié sans modification nécessaire** : `buildFormalisme()`
(`documentFormalisme.ts`) traite déjà un `champsDocument` vide/absent comme
"pas de formalisme spécifique" (`Object.keys(c).length === 0 → return null`)
et retombe sur l'affichage générique - ce chemin est déjà emprunté en
production par les types sans `champsDocument` (recherche, traduction...).
Confirmé par deux nouveaux tests (`documentExport.test.ts`) qui exportent en
Word et PDF une entrée avec `typeAction` défini mais `champsDocument: null`
: aucun crash, aucun `"undefined"` dans le document produit.

---

## Partie C — Avertissement à l'export + cohérence visuelle

- **Mention d'avertissement** (`buildMentionAvertissement()`,
  `documentExport.ts`) : pied de page réel sur l'export Word (`docx`
  `Footer`), dernière ligne du document sur l'export PDF (PDFKit ne propose
  pas de pied de page répété par page sans complexifier significativement le
  moteur de rendu - choix explicitement laissé libre par la spec dans ce
  cas). Varie selon `Action.statut` : *"Document en cours de validation —
  non définitif. [...]"* tant que non `valide`/`envoyé`, sinon la mention
  simple avec la date d'export.
- **Fond de l'éditeur** : `.edit-panel textarea` passe de `var(--bg)`
  (fond de page) à `var(--panel)` - exactement le même token que
  `.accordion-body` (zone d'aperçu du document généré), donc blanc en thème
  clair et cohérent en thème sombre. Aucun autre style touché (police,
  marges, barre d'outils), contraste du texte (`var(--text)`) déjà adapté
  aux deux thèmes.

---

## Fichiers livrés

**Partie A**
- `backend/src/middleware/verifierVerrou.ts` (nouveau)
- `backend/src/routes/actionVersions.ts` (nouveau - 5 routes)
- `backend/src/jobs/liberationVerrousExpires.ts` (nouveau)
- `backend/src/routes/actionsCallback.ts` (modifié - garde sur `/valider`,
  retrait de `PATCH /contenu`)
- `backend/src/routes/dossiers.ts` (modifié - inclut `versions` +
  `verrouilleParUtilisateur`)
- `backend/src/index.ts` (modifié - planification du job)
- `backend/public/dossier.html` (modifié - panneau verrou + historique des
  versions)

**Partie B**
- `backend/src/services/gabaritsRedactionLibre.ts` (nouveau)
- `backend/src/routes/actionsRedactionLibre.ts` (nouveau)
- `backend/src/routes/webActions.ts` (modifié - `findOrCreateDossier`
  exportée, réutilisée telle quelle - aucune autre logique touchée)
- `backend/public/nouvelle-action.html` (modifié - écran de choix de mode +
  écran rédaction libre)

**Partie C**
- `backend/src/services/documentExport.ts` (modifié - mention + `Footer`)
- `backend/src/routes/documentExport.ts` (modifié - `statut` transmis)
- `backend/public/style.css` (modifié - fond de l'éditeur + badge
  `revision_demandee` déjà présent du Lot 10)

**Commun aux trois parties**
- `backend/prisma/schema.prisma` (modifié - `Action.verrouillePar/
  verrouilleLe/versionActuelle/modeCreation`, modèle `ActionVersion`)
- `backend/prisma/migrations/20260807010000_documents_sequentiels_et_redaction_libre/migration.sql`
  (nouveau, migration unique regroupant A + B)
- `backend/prisma/portable-init.sql` (régénéré)
- `backend/src/app.ts` (modifié - enregistrement des 2 nouveaux routeurs)
- `backend/tests/e2e/documents-sequentiels.test.ts` (nouveau, 15 tests)
- `backend/tests/e2e/redaction-libre.test.ts` (nouveau, 7 tests)
- `backend/src/services/__tests__/gabaritsRedactionLibre.test.ts` (nouveau)
- `backend/src/services/__tests__/documentExport.test.ts` (modifié - 5
  nouveaux tests : champsDocument absent + mention Word/PDF)
- `README-LOT11.md` (ce fichier)

**Non modifiés** (vérifié) : `documentFormalisme.ts`, la logique de
génération IA/pseudonymisation existante dans `webActions.ts`, `webForms.ts`.

## Ce qui a été réellement testé

Suite complète du projet rejouée après ce lot (exécution séquentielle pour
éviter la contention de plusieurs clusters PostgreSQL jetables en parallèle
sur cette machine - chaque suite passe aussi individuellement en parallèle) :
**117/117 tests passés**, `tsc --noEmit` propre, `eslint` sans nouvelle
erreur (3 erreurs préexistantes, hors fichiers de ce lot).

`documents-sequentiels.test.ts` (15 tests, PostgreSQL réel) : prise/blocage/
idempotence du verrou, refus de sauvegarde sans verrou, deux versions
successives sans impact sur `contenuGenere`, historique trié, refus de
validation par un collaborateur, libération explicite, blocage de l'ancienne
route `/valider` dès qu'un cycle de versions a démarré, validation d'une
version (fige `contenuGenere`/`statut`), document validé non réouvrable
directement, blocage si remarque ouverte, libération automatique par le job
(appelé directement), reprise immédiate d'un verrou expiré sans attendre le
job.

`redaction-libre.test.ts` (7 tests, PostgreSQL réel) : création complète
(gabarit injecté, `modeCreation`, `champsDocument` null), rejet sans nom de
client, rejet d'un type invalide, absence d'appel LLM (mock intercepté,
`callCount === 0`) et de pseudonymisation, réutilisation d'un dossier
existant par numéro, export Word/PDF réel sans erreur, intégration complète
au cycle verrou/version de la Partie A.

## Non testé dans cet environnement

- **Rendu visuel réel** de l'écran de choix de mode, du panneau verrou/
  historique des versions et du fond de l'éditeur dans un navigateur (pas
  d'environnement UI disponible ici) - la logique JS a été relue et
  syntaxiquement validée (`new Function(...)` sur les blocs `<script>`),
  mais pas cliquée. À vérifier manuellement avant mise en production : cycle
  complet Modifier → Enregistrer → historique → Valider une version, écran
  "Rédiger librement" de bout en bout, lisibilité du nouveau fond de
  l'éditeur dans les deux thèmes.
- **Édition concurrente réelle depuis deux navigateurs simultanés** :
  couverte via deux sessions HTTP distinctes dans les tests (équivalent
  fonctionnel), pas via deux vrais onglets de navigateur ouverts en
  parallèle.
