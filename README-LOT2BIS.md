# Lot 2bis : chiffrement au repos

Complement au [Lot 2](README-LOT2.md) (PostgreSQL portable) : chiffrement au
repos des champs les plus sensibles de la base (identite client, contenu des
documents generes), en plus - pas a la place - de la pseudonymisation deja
prevue pour les appels LLM et de BitLocker (checklist fournie dans
[installer/README-BITLOCKER.md](installer/README-BITLOCKER.md)).

Aucune modification de `webForms.ts`, `webActions.ts`, `documentExport.ts`,
`documentFormalisme.ts`, `markdownParse.ts`, `services/llm/`, ni des routes
metier (`routes/clients.ts`, `routes/dossiers.ts`, `routes/factures.ts`,
`routes/actions.ts`, `routes/actionsCallback.ts`...) - verifie via `git
status` avant livraison. Ce lot est une couche d'infrastructure transparente
et quelques annotations de `schema.prisma`.

## Choix (a) vs (b) : chiffrement applicatif (Node), pas pgcrypto

Le prompt demandait de trancher explicitement entre :
- **(a)** `pgcrypto` cote PostgreSQL (`pgp_sym_encrypt`/`pgp_sym_decrypt`)
- **(b)** chiffrement cote application (Node `crypto`, AES-256-GCM)

**Retenu : (b)**, pour les raisons suivantes (recommandation par defaut du
prompt, confirmee apres implementation) :

1. **Independance du moteur de base de donnees.** Aurore tourne en mode
   portable (PostgreSQL embarque, Lot 2), reseau (Lot 6, serveur LAN du
   cabinet) et externe (VPS actuel) - le chiffrement applicatif fonctionne
   identiquement dans les trois cas, sans rien demander a l'instance
   Postgres au-dela d'une colonne `String`/`Json` ordinaire. `pgcrypto`
   marche aussi partout mais deplace la responsabilite de la cle vers
   chaque requete SQL (`pgp_sym_encrypt(valeur, cle)`), ce qui expose la cle
   dans les logs de requetes SQL si le logging est jamais active par erreur.
2. **Auditabilite.** Toute la logique de chiffrement tient dans un seul
   fichier (`server/src/security/encryptionAtRest.ts`, ~200 lignes, module
   `crypto` natif Node, zero dependance tierce) - plus simple a relire et
   auditer qu'une chaine de fonctions SQL invoquees a travers Prisma.
3. **Independance du reseau entre l'app et la base.** Si le mode reseau
   (Lot 6) fait un jour transiter des requetes entre le poste client et le
   serveur du cabinet sur le LAN, les valeurs sont deja chiffrees au moment
   ou Prisma les envoie a Postgres - `pgcrypto` chiffrerait cote serveur
   Postgres, donc apres transit sur le reseau si TLS n'est pas actif sur la
   connexion Postgres elle-meme.

`pgcrypto` est neanmoins active sur l'instance (migration ci-dessous,
inclus automatiquement dans `prisma/portable-init.sql` via
`extensions = [vector, pgcrypto]` dans `schema.prisma`) pour rester
disponible sans friction si un besoin futur apparait (ex: primitives
cryptographiques cote SQL pour un outillage de rotation de cle) - il n'est
pas utilise par le mecanisme de chiffrement des champs lui-meme.

## Champs chiffres

Marques `// [chiffre-au-repos]` directement dans `schema.prisma` :

| Modele | Champs | Type de stockage |
|---|---|---|
| `Client` | `nom`, `email`, `telephone`, `numeroPieceIdentite`, `quartierResidence`, `rue`, `autrePrecision`, `maison` | `String?` inchange (blob chiffre encode en base64, prefixe `enc:v1:`) |
| `Action` | `contenuGenere` | `String?` inchange |
| `Action` | `champsDocument` | `Json?` inchange - stocke comme scalaire JSON string chiffre (`"enc:v1:..."`), pas comme objet JSON en clair |

**Deliberement exclus** (contrainte explicite du prompt : "ne pas chiffrer
les champs utilises dans des WHERE/recherches frequentes") :
- `Client.id`, `cabinetId`, dates, statuts, booleens - cles/filtres.
- `Client.notes`, `lieuNaissance`, `situationMatrimoniale`, `fonction`,
  `entreprise`, `adresseEntreprise`, `dateNaissance`, `civilite`,
  `typePersonne` - non demandes explicitement par le prompt ; a envisager
  dans une extension future si besoin (il suffit d'ajouter l'entree
  correspondante dans `ENCRYPTED_FIELDS_BY_MODEL`, voir plus bas).
- `Dossier.nomClient` - champ texte libre denormalise, distinct de la
  relation `Client`, non concerne.
- `Action.champsFormulaire` - copie brute de saisie de formulaire (distincte
  de `champsDocument`), non demandee explicitement par le prompt.
- Aucun champ de `User`, `Cabinet`, `Facture`, `DelaiType`, `RoleAudience`,
  `JurisprudenceChunk` (le RAG jurisprudence n'est pas concerne, comme
  precise dans le prompt).

Verifie par recherche exhaustive dans les routes (`grep` sur `where:`,
`orderBy:`, `contains`, `select`) qu'aucun de ces 9 champs n'est utilise
dans un filtre ou un tri SQL - a une exception : `routes/clients.ts`
trie par `orderBy: { nom: "asc" }`. Traite explicitement (voir
"Angles morts decouverts" ci-dessous) plutot qu'ignore.

## Architecture

```
server/src/security/
  encryptionAtRest.ts   - primitives generiques : encryptField/decryptField
                           (AES-256-GCM), encryptJsonField/decryptJsonField,
                           gestion de la cle (generation/chargement/cache).
                           Ne connait ni Prisma ni les modeles metier.
  prismaEncryption.ts    - branchement Prisma : extension $extends
                           $allModels.$allOperations, construite a partir du
                           DMMF (Prisma.dmmf.datamodel.models) pour propager
                           le dechiffrement dans les lectures imbriquees.

server/src/lib/prisma.ts - export du client Prisma singleton, desormais
                            enveloppe par withEncryptionAtRest().
```

Le reste du code (30 fichiers qui font `import { prisma } from
"../lib/prisma"`) est **inchange** : `prisma.client.create({ data: { nom:
"..." } })` ecrit toujours un objet en clair, `client.nom` est toujours en
clair a la lecture, quel que soit le chemin (direct, ou imbrique via
`include`/`select` depuis un autre modele).

### Format de stockage

`enc:v1:<iv base64>:<authTag base64>:<ciphertext base64>` - un prefixe
explicite permet de distinguer une valeur chiffree d'une valeur en clair
ecrite avant l'activation de ce lot (retro-compatibilite : une valeur sans
ce prefixe est retournee telle quelle, jamais une erreur). IV aleatoire de
12 octets a chaque chiffrement (jamais reutilise), tag d'authentification
GCM verifie au dechiffrement (integrite - toute alteration du texte chiffre
est detectee et rejetee, jamais silencieusement acceptee).

Pour `champsDocument` (colonne `Json?`), la valeur chiffree est stockee
comme un **scalaire JSON string** (`"enc:v1:..."`), valide du point de vue
de Postgres pour une colonne `jsonb`. Au dechiffrement, la chaine est
dechiffree puis re-parsee en JSON pour redonner l'objet original.

### Cle de chiffrement

Generee une seule fois par installation (32 octets aleatoires,
`crypto.randomBytes`), stockee dans
`%APPDATA%/Aurore/secrets/encryption-key.json` - **le meme dossier protege
que les identifiants Postgres portable du Lot 2** (permissions restreintes
via `icacls` sur Windows, `chmod 600` ailleurs). Jamais en dur dans le code,
jamais commise, jamais loguee. Une variable d'environnement
`AURORE_ENCRYPTION_KEY` (base64, 32 octets) permet de surcharger ce
mecanisme pour une gestion de cle externalisee, sans jamais apparaitre dans
le code source.

### Angles morts decouverts et traites

En ecrivant le test empirique ci-dessous, deux limites reelles de
l'approche naive "extension Prisma par modele" ont ete identifiees et
corrigees avant livraison :

1. **Lectures imbriquees.** L'extension `query` de Prisma ne se declenche
   que pour le modele directement interroge (`prisma.client.findMany()`
   declenche l'extension pour `Client`, mais `prisma.dossier.findFirst({
   include: { client: true, actions: true } })` ne declenche PAS
   automatiquement l'extension pour les lignes `Client`/`Action` imbriquees
   dans le resultat). Or `routes/dossiers.ts` (fiche dossier) et
   `routes/factures.ts` (liste des factures) font exactement ce genre
   d'inclusion imbriquee pour afficher le nom du client / le contenu d'une
   action. Sans traitement specifique, ces deux ecrans auraient affiche du
   texte chiffre illisible au lieu du contenu attendu.
   **Correction** : `prismaEncryption.ts` construit, a partir du DMMF
   Prisma, la table complete des relations objet entre modeles, et parcourt
   recursivement TOUT arbre de resultat retourne par N'IMPORTE QUELLE
   requete (peu importe le modele de depart) pour dechiffrer les champs
   designes a n'importe quelle profondeur d'imbrication. Un calcul de
   fermeture transitive (`RELEVANT_MODELS`) evite de parcourir en vain les
   resultats de modeles sans aucun rapport (`JurisprudenceChunk`,
   `DelaiType`...).
2. **Tri SQL sur un champ chiffre.** `routes/clients.ts` trie la liste des
   clients avec `orderBy: { nom: "asc" }`. Une fois `nom` chiffre, Postgres
   trierait par ordre alphabetique du texte chiffre (aleatoire du point de
   vue humain), pas du nom reel.
   **Correction** : apres dechiffrement, si le `orderBy` de la requete
   portait sur un champ chiffre du modele interroge, le resultat est retrie
   en JavaScript (tri stable, criteres appliques dans l'ordre) - sans
   modifier `routes/clients.ts`.

Ces deux corrections vivent entierement dans `prismaEncryption.ts` (couche
d'acces), pas dans le code metier.

### Limite documentee (non traitee, car non utilisee aujourd'hui)

Le chiffrement a l'ECRITURE ne traite que les ecritures **directes** sur
`Client`/`Action` (`prisma.client.create/update(...)`,
`prisma.action.create/update(...)`) - verifie par recherche exhaustive que
c'est la seule forme utilisee dans tout le projet a ce jour. Une future
ecriture imbriquee du type `prisma.dossier.update({ data: { client: {
update: { nom: "..." } } } } })` ne serait PAS interceptee et ecrirait le
nom en clair. Si un tel usage apparait, utiliser `prisma.client.update()`
directement (deja le seul pattern du projet), ou etendre
`applyWriteEncryption()` dans `prismaEncryption.ts`.

## Rotation de cle (procedure documentee, non automatisee dans ce lot)

Comme demande par le prompt ("pas necessairement automatisee dans ce lot,
pour ne pas bloquer une evolution future"), aucun outil de rotation n'est
livre - mais la procedure a suivre le jour ou une rotation est necessaire
(suspicion de compromission de la cle, politique de securite du cabinet) :

1. Charger l'ANCIENNE cle (`AURORE_ENCRYPTION_KEY` ou le fichier existant)
   et generer une NOUVELLE cle (`crypto.randomBytes(32)`).
2. Pour chaque table concernee (`clients`, `actions`), pour chaque ligne :
   lire la valeur brute en base (`decryptField` avec l'ancienne cle),
   rechiffrer avec la nouvelle cle (`encryptField`), ecrire.
   Faire cela dans une transaction par lot (ex: 500 lignes), pour pouvoir
   reprendre en cas d'interruption sans tout refaire.
3. Ne remplacer le fichier de cle qu'une fois **toutes** les lignes
   confirmees rechiffrees (sinon certaines lignes deviendraient
   illisibles).
4. Conserver l'ancienne cle en lieu sur pendant une periode de secours
   (ex: 30 jours) avant de la detruire definitivement.

Ce script pourra reutiliser directement `encryptField`/`decryptField` de
`encryptionAtRest.ts` (deja concues comme des primitives independantes de
Prisma) et `raw.$queryRawUnsafe`/`$executeRawUnsafe` pour bypasser
l'extension de chiffrement automatique pendant l'operation elle-meme.

## Perte de cle : donnees irrecuperables (pas de porte derobee)

Comme demande explicitement par le prompt : **si le fichier
`encryption-key.json` est perdu (reinstallation sans sauvegarde du dossier
`secrets/`, corruption disque non couverte par BitLocker...) et qu'aucune
copie n'existe ailleurs, les champs chiffres sont definitivement
illisibles.** Il n'existe et n'existera aucun mecanisme de recuperation
sans la cle - c'est la garantie meme du chiffrement (une porte derobee
annulerait la protection).

**Consequence pratique pour le cabinet** : sauvegarder le dossier
`%APPDATA%/Aurore/secrets/` (cle de chiffrement + identifiants Postgres) au
meme titre que les sauvegardes `pg_dump` elles-memes (voir README-LOT2.md).
Une sauvegarde `pg_dump` sans la cle correspondante est inutilisable pour
les champs chiffres.

**Comportement observe en cas de cle absente/incorrecte** (verifie
empiriquement ci-dessous) : chaque tentative de lecture d'un champ chiffre
leve une `FieldEncryptionError` explicite, loguee sans jamais exposer la
cle ni le texte chiffre en clair - pas de donnees corrompues affichees, pas
d'echec silencieux.

## Ce qui a ete reellement teste (et comment)

Contrairement au pgvector du Lot 2 (bloque par l'absence de Visual Studio
Build Tools dans cet environnement), le chiffrement applicatif ne depend
d'aucun outillage externe : il a pu etre teste de bout en bout contre une
**vraie instance PostgreSQL** (reutilisation des binaires d'une installation
PostgreSQL 17 deja presente sur la machine de developpement - cluster de
test jetable initialise dans un repertoire separe via `initdb`/`pg_ctl`,
sans toucher au service Postgres existant, detruit apres le test).

Schema de test : `prisma/portable-init.sql` prive de l'extension `vector`
et de la colonne `embedding` (non pertinent pour ce lot, meme limite
documentee que le Lot 2), applique tel quel sinon (memes tables, memes
contraintes que la production).

Script de test : cree une fois pour cette verification, execute, puis
**supprime** (non commis - voir `git status` avant livraison). Resultats
observes reellement (extraits) :

```
=== 3) Lecture SQL brute (doit etre illisible) ===
{
  nom: 'enc:v1:2Sj5hdQNqsE/6fZA:XWL9JZCBaajoCNdvKu2N0g==:LI1GySQc6AG58zL0ARDvcQ==',
  email: 'enc:v1:IcrwGzeTgVtWzFSc:...',
  ...
}
nom stocke chiffre ?  true

=== 4) Relecture via l'API (findFirst) - doit etre dechiffree ===
KODJO Marcelline marcelline@example.com CNI-123456

=== 6) Lecture imbriquee : dossier -> client + actions (comme routes/dossiers.ts) ===
client.nom imbrique : KODJO Marcelline
action.contenuGenere imbrique : Texte confidentiel des conclusions.
action.champsDocument imbrique : { demandeur: 'KODJO Marcelline', montant: 500000 }

=== 7) orderBy nom malgre le chiffrement ===
Ordre obtenu : [ 'ABALO Jean', 'KODJO Marcelline', 'ZINSOU Paul' ]

=== 9) Donnee chiffree corrompue -> echec propre ===
OK: FieldEncryptionError levee proprement (donnee corrompue) : Impossible de
dechiffrer une donnee sensible : cle de chiffrement absente/incorrecte pour
cette installation, ou donnee corrompue.

=== 9b) Fichier de cle absent/incorrect au demarrage d'un NOUVEAU process ===
OK sous-process: echec propre -> FieldEncryptionError : Impossible de
dechiffrer une donnee sensible : ...

=== 10) Donnee en clair anterieure au chiffrement (retro-compatibilite) ===
Champ ecrit en clair avant ce lot, relu normalement : Cotonou (ecrit avant ce lot)

=== 11) Mesure de performance simple ===
200 creations chiffrees : 467ms (2.33ms/creation)
findMany + tri dechiffre de 203 clients : 47ms
```

Couvre les criteres d'acceptation du prompt : champs illisibles en base
brute, code metier fonctionnant sans modification (create/update/findFirst/
findMany en clair de son point de vue), lecture imbriquee correcte
(equivalent de "relire un client via l'API, verifier l'affichage
dechiffre"), echec propre et explicite sur cle absente/donnee corrompue
(simule deux facons : donnee corrompue en cours de process, et fichier de
cle incorrect dans un process frais), retro-compatibilite avec des donnees
ecrites avant l'activation du lot, performance negligeable (~2ms par
ecriture chiffree, tri de 200+ lignes dechiffrees en <50ms - aucun
ralentissement perceptible sur une fiche client ou un dossier).

## Non teste dans cet environnement

- **Activation reelle de BitLocker** (`installer/enable-bitlocker.ps1`) :
  necessite un poste Windows physique avec droits administrateur complets
  et acceptation d'un chiffrement de disque reel - non executable dans cet
  environnement de developpement. Le script a ete relu attentivement
  (garde-fous : verification d'edition Windows, verification des droits
  admin, confirmation interactive explicite avant toute modification,
  sauvegarde de la cle de recuperation affichee a l'ecran) mais n'a pas pu
  etre execute avec `-Enable` pour de vrai.
- **Migration SQL sur le VPS de production** : le fichier
  `prisma/migrations/20260802000000_enable_pgcrypto/migration.sql` n'a pas
  ete applique au VPS Hostinger existant (hors de portee de cette session) -
  a executer manuellement via `psql "$DATABASE_URL" -f
  prisma/migrations/20260802000000_enable_pgcrypto/migration.sql` lors du
  prochain deploiement.

## Fichiers livres

- `server/src/security/encryptionAtRest.ts` (nouveau)
- `server/src/security/prismaEncryption.ts` (nouveau)
- `server/src/lib/prisma.ts` (modifie - branchement de l'extension)
- `server/prisma/schema.prisma` (modifie - `pgcrypto` ajoute aux
  extensions du datasource, annotations `[chiffre-au-repos]`)
- `server/prisma/portable-init.sql` (regenere - inclut desormais
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto"`)
- `server/prisma/migrations/20260802000000_enable_pgcrypto/migration.sql`
  (nouveau)
- `server/.env.example` (modifie - `AURORE_ENCRYPTION_KEY` documentee)
- `installer/enable-bitlocker.ps1` (nouveau)
- `installer/README-BITLOCKER.md` (nouveau)
- `README-LOT2BIS.md` (ce fichier)

## Coordination avec le futur Lot 8 (desinstallation)

Meme principe que documente dans README-LOT2.md pour les identifiants
Postgres : le dossier `%APPDATA%/Aurore/secrets/` (qui contient desormais
AUSSI la cle de chiffrement, a cote des identifiants Postgres) ne doit
JAMAIS etre supprime automatiquement par un desinstalleur sans confirmation
explicite et distincte de la confirmation de desinstallation elle-meme - sa
suppression rend immediatement et definitivement illisibles les champs
chiffres de toute sauvegarde `pg_dump` existante.
