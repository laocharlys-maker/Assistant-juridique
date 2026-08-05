# Lot 8ter — Retrait complet de n8n

Le bug corrige au Lot 8bis (statut de document bloque sur "brouillon" en
poste unique/desktop, avec un faux message d'echec et l'absence du bouton
"Marquer comme valide") a revele que le webhook n8n `document-callback`
etait encore un point de passage silencieux dans le workflow de statut des
documents. Ce lot retire entierement la dependance n8n plutot que de
laisser ce code mort recreer le meme type de piege ailleurs.

## 1. Ce qui a ete abandonne (decision produit)

n8n servait a trois usages herites du SaaS d'origine, tous les trois
abandonnes pour la version desktop :

- **WhatsApp** : fonctionnalite supprimee du produit (route
  `/api/actions/whatsapp`, extraction IA depuis un message WhatsApp,
  reponse automatique).
- **Lien Google Docs editable** : supprime - l'export Word/PDF natif
  (deja en place) suffit. Le callback `/api/actions/document-callback`
  qui faisait avancer le statut a la reception du document Google Docs
  n'existe plus.
- **Rappels Google Calendar** : supprimes - la page "Echeances", deja
  presente dans l'app, couvre ce besoin (delais de procedure ET role de la
  semaine).

Les emails de rappel/notification (facture, email libre a un client, test
d'adresse de contact, recapitulatif hebdomadaire du role, veille
juridique) passaient egalement par des webhooks n8n dedies. Ils sont
**portes vers Brevo/Nodemailer** (`services/mailer.ts`), deja en place
pour l'envoi des documents (`sendDocumentEmail`) : le backend composait
deja integralement le contenu de ces emails (texte, ou HTML complet pour
le recapitulatif du role et la veille juridique) avant de le transmettre a
n8n pour l'envoi effectif - seul ce dernier maillon change, aucun contenu
d'email n'est modifie.

## 2. Fichiers supprimes

- `src/services/n8n.ts` (`callN8nWebhook`, `webhookForAction`) - plus
  aucun appelant.
- `src/routes/actions.ts` (`POST /api/actions/whatsapp`) - route
  entierement dediee a WhatsApp, retiree avec son montage dans `app.ts`.

## 3. Fichiers modifies

**Suppression du webhook de callback document (Google Docs) :**
- `src/routes/actionsCallback.ts` : retrait de
  `POST /api/actions/document-callback` et de son schema.
- `src/routes/webActions.ts` : retrait de l'appel `callN8nWebhook()` a la
  fin de la generation - le statut passe desormais directement a
  `en_attente_validation` a la creation de l'action (le correctif du Lot
  8bis faisait deja cette avancee en aval, de facon conditionnelle ; elle
  est maintenant inconditionnelle puisqu'il n'y a plus de webhook a
  attendre). Retrait aussi du calcul `enteteUrl`/`PUBLIC_BASE_URL`, qui ne
  servait qu'a construire un lien absolu pour n8n.

**Rappels Calendar (retires, remplaces par "Echeances") :**
- `src/routes/delais.ts` : retrait de `creerRappelCalendar` et de l'appel
  n8n associe dans `POST /api/delais/calculer`.
- `src/routes/roleAudiences.ts` : retrait de `creerRappelCalendar` et de
  l'appel n8n associe dans `POST /api/role-audiences`.
- `public/delais-calculateur.html`, `public/role-semaine.html` : retrait
  de la case a cocher "Creer un rappel dans Google Calendar".
- `public/dossier.html`, `public/echeances.html` : retrait de l'affichage
  "rappel Calendar cree".

**Emails portes vers Brevo/Nodemailer :**
- `src/services/mailer.ts` : ajout de `sendEmail()`, fonction generique
  (sujet + texte/HTML + pieces jointes optionnelles) reutilisee par les
  cinq usages ci-dessous.
- `src/routes/factures.ts`, `src/routes/admin.ts` : envoi de facture
  (PDF en piece jointe) - sujet et texte repris a l'identique du template
  n8n d'origine (`n8n-reference/aurore-envoyer-facture.json`).
- `src/routes/clients.ts` : email libre a un client depuis sa fiche (sujet
  = objet saisi, corps = message saisi, piece jointe optionnelle decodee
  depuis la data URL fournie par le frontend).
- `src/routes/cabinet.ts` : test de l'adresse de contact du cabinet.
- `src/services/roleSemaineRecap.ts`, `src/services/veilleJuridique.ts` :
  recapitulatif hebdomadaire du role et veille juridique - le HTML complet
  etait deja construit localement (`roleSemaineRecapEmail.ts`,
  `veilleJuridiqueEmail.ts`), seul le canal d'envoi change.
- `public/clients.html`, `public/nouvelle-action.html` : retrait des
  messages/branchements bases sur `n8nDispatched` (le frontend s'appuie
  desormais sur la gestion d'erreur standard `apiFetch`/HTTP).

**Nettoyage config/documentation :**
- `src/config/env.ts`, `.env.example` : retrait de `N8N_WEBHOOK_BASE_URL`,
  `N8N_WEBHOOK_SECRET`, `PUBLIC_BASE_URL` (plus aucun usage), et des
  variables deja mortes `EVOLUTION_API_URL`/`EVOLUTION_API_KEY`
  (WhatsApp/Evolution API) et `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`
  (OAuth Google Docs) - aucune des deux n'etait plus lue nulle part dans
  `src/`.
- Commentaires mentionnant n8n mis a jour dans `src/index.ts`,
  `src/config/bundledExternalServiceKeys.ts`,
  `src/utils/documentNaming.ts`, `src/schemas/webForms.ts`,
  `src/services/documentFormalisme.ts`, `src/routes/auditLogs.ts`,
  `public/style.css`, `public/parametres.html`, `README.md`.
- `public/journal-plateforme.html` : retrait des filtres d'audit
  `declenchement_n8n`/`document_pret`, devenus definitivement inutilisables
  (plus aucun code n'ecrit ces valeurs).
- `src/routes/admin.ts` : `ETAPES_AUDIT` (filtre d'audit) reduit en
  consequence.

## 4. Ce qui n'a volontairement PAS ete touche

- **`n8n-reference/*.json`** : exports des workflows n8n historiques,
  explicitement conserves comme reference versionnee - voir
  `Aurore_Cahier_des_charges.md` ("Le fichier
  `Solution_Assistant_Juridique_NEW__1_.json`... est conserve dans le
  repo comme reference historique"). Aucun code actif ne les lit.
- **`Aurore_Cahier_des_charges.md`** : document de specification historique
  decrivant l'architecture v1 (n8n comme cerveau puis comme couche
  d'integration) et la decision de pivot vers le backend - non modifie,
  c'est un journal de decisions, pas une documentation d'etat actuel.
- **`Action.documentUrl`/`Action.documentId`** (Prisma) : alimentes par
  l'ancien callback de generation Google Docs, desormais toujours `null`.
  **`DelaiCalcul.rappelCalendar`** : toujours `false` desormais. Conserves
  sans migration de suppression - colonnes orphelines non bloquantes,
  une migration destructive n'etait pas necessaire pour ce lot.
- **`Canal.whatsapp`** (enum Prisma) : conserve pour ne pas invalider
  d'eventuelles actions historiques deja enregistrees avec ce canal ;
  plus aucun code ne cree de nouvelle action avec ce canal.
- Le lien de contact rapide `https://wa.me/{telephone}` sur la fiche
  client (`public/clients.html`) : feature independante de n8n (simple
  lien `wa.me`, aucune route backend), non concernee par le retrait.
- Logique de generation/pseudonymisation/export/calcul de delais
  (`webActions.ts`, `documentFormalisme.ts`, `webRedaction.ts`,
  `anonymizer.ts`, `services/delais.ts`...) : non modifiee, a l'exception
  des lignes retirant directement l'appel n8n et le calcul `enteteUrl`
  desormais mort dans `webActions.ts`.

## 5. Tests

- `npx tsc --noEmit` : aucune erreur.
- `npx vitest run` : 9 fichiers de tests unitaires/integration reels tous
  au vert (aucun test n'assertait sur un comportement n8n - rien a
  adapter). Deux tests e2e (`licence-expiry-flow`,
  `full-workflow > bloque l'acces API sans licence active`) echouent —
  confirme **pre-existant, non lie a ce lot** en rejouant les memes tests
  sur le commit precedent (meme echec 200 au lieu de 403 avant tout
  changement de ce lot).
- Testé sur le binaire SEA reel (`dist-sea/aurore-backend.exe`), instance
  isolee : generation d'un document de bout en bout, statut
  `en_attente_validation` immediat (sans passer par le detour "brouillon"
  du Lot 8bis), bouton de validation present, aucune reference n8n dans
  les logs de demarrage/execution.
