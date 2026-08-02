# Lot 6 : mode serveur réseau (multi-poste)

Permet à un PC/mini-PC du cabinet de servir Aurore aux autres postes du
réseau local, sans rien installer sur ces derniers (navigateur uniquement).
Complémentaire au mode "Poste unique" (Lots 1/2/3/5), jamais un
remplacement : le binaire reste strictement le même, seul le binding
réseau et le protocole (HTTP → HTTPS) changent selon un choix de
configuration local.

Aucune modification de logique métier - vérifié via `git status` : seuls
`app.ts`/`index.ts` (montage du routeur + décision de binding, même
catégorie d'infrastructure que les Lots 2/3), `public/js/api.js` (redirection
vers l'écran de premier lancement) sont touchés en dehors des nouveaux
fichiers listés ci-dessous.

## Sommaire

- [Installation en mode serveur](#installation-en-mode-serveur)
- [Connexion des postes clients](#connexion-des-postes-clients)
- [Mode service pur (NSSM)](#mode-service-pur-nssm)
- [Résilience réseau (IP qui change, mDNS)](#résilience-réseau-ip-qui-change-mdns)
- [Dépannage réseau courant](#dépannage-réseau-courant)
- [Ce qui a été réellement testé](#ce-qui-a-été-réellement-testé)
- [Architecture](#architecture)

## Installation en mode serveur

1. **Lancer Aurore normalement** (coquille Tauri) sur le poste qui doit
   servir de serveur. Au tout premier lancement, l'écran de configuration
   s'affiche automatiquement (`setup-mode.html`) - choisir **"Serveur
   réseau"**. Le choix est enregistré dans
   `%APPDATA%/Aurore/config.json` et n'est plus redemandé ensuite (voir
   `server/src/config/deploymentMode.ts`).
2. **Redémarrer Aurore** (fermer puis rouvrir) : le nouveau binding
   (`0.0.0.0`) et le certificat HTTPS local sont appliqués au démarrage
   suivant - un changement de mode ne se rebind jamais "à chaud" en cours
   d'exécution (voir `routes/networkInfo.ts`).
3. **Ouvrir le pare-feu** (Administrateur, une seule fois) :
   ```
   powershell -ExecutionPolicy Bypass -File installer\firewall-rule.ps1
   ```
   N'ouvre le port **que** sur le profil réseau "Privé" - jamais "Public"
   ni "Domaine". Si le script signale qu'une interface n'est pas classée
   "Privée", reclassez-la (Paramètres Windows > Réseau et Internet >
   [votre réseau] > Profil réseau > Privé) avant de continuer.
4. **Récupérer l'adresse de connexion** : ouvrir `setup-mode.html` depuis
   le poste serveur (accessible à tout moment, pas seulement au premier
   lancement) - il affiche l'IP locale et le nom `aurore.local` à
   communiquer aux autres postes.
5. **Distribuer le certificat aux postes clients** (recommandé, évite
   l'avertissement de sécurité définitivement) - voir
   `installer/import-cert-instructions.md`.

## Connexion des postes clients

Depuis un navigateur, sur n'importe quel poste du **même réseau privé** :

- `https://aurore.local:3000` (recommandé - fonctionne même si l'IP
  change, voir résilience réseau)
- `https://<IP-du-serveur>:3000` (solution de secours si `aurore.local` ne
  résout pas - certains réseaux d'entreprise bloquent le mDNS)

Le port par défaut est **3000** (déjà configurable depuis le Lot 1) - à
adapter si le cabinet en a choisi un autre, y compris dans la règle
pare-feu (`-Port` de `firewall-rule.ps1`) et un éventuel port-forwarding
routeur (non nécessaire pour un usage strictement local).

Au premier accès, le navigateur affiche un avertissement de certificat
(normal, certificat auto-signé - voir `installer/import-cert-instructions.md`
pour l'accepter une fois ou l'importer définitivement).

### Raccourci "mode kiosque" Chrome (optionnel)

Pour qu'un poste client ouvre Aurore directement en plein écran, sans
barre d'adresse (comme une application dédiée), créer un raccourci Windows
avec cette cible :

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --app=https://aurore.local:3000
```

(remplacer par l'IP si `aurore.local` ne fonctionne pas sur ce réseau).
Clic droit sur le raccourci > Propriétés > icône personnalisée si souhaité.
Ce mode reste une simple fenêtre de navigateur : les mises à jour d'Aurore
n'imposent aucune réinstallation côté poste client.

## Mode service pur (NSSM)

Pour un mini-PC serveur dédié, sans écran branché en permanence, sans
session utilisateur ouverte - alternative à la coquille Tauri (qui reste
utile si le poste serveur est AUSSI un poste de travail normal).

1. **Copier le build SEA complet** (`dist-sea/`, voir `README-LOT1.md`) sur
   le poste serveur, ex: `C:\Aurore\` - le dossier entier
   (`aurore-backend.exe`, `public/`, `node_modules/`, `postgres/`,
   `prisma/`), jamais des fichiers déplacés individuellement.
2. **Installer NSSM** (outil tiers, https://nssm.cc/download) - télécharger
   `nssm.exe` (version 64 bits) et le placer à côté du script ou sur le
   `PATH`.
3. **Installer le service** (Administrateur) :
   ```
   powershell -ExecutionPolicy Bypass -File installer\aurore-service-install.ps1 -InstallDir "C:\Aurore"
   ```
   Configure `DATABASE_MODE=portable` (même chemin d'amorçage Postgres
   portable + choix de binding réseau que la coquille Tauri - **aucune
   logique dupliquée**, voir `index.ts`), démarrage automatique au boot
   Windows, redémarrage automatique en cas de crash.
4. **Choisir le mode réseau** : au premier démarrage du service, se
   connecter à `http://127.0.0.1:3000/setup-mode.html` **depuis le poste
   serveur lui-même** (ou via Bureau à distance) pour faire le choix
   initial, puis redémarrer le service (`Restart-Service Aurore`).
5. **Vérifier** :
   ```powershell
   Get-Service Aurore
   Invoke-RestMethod https://127.0.0.1:3000/health -SkipCertificateCheck
   ```

**Confort (Tauri) vs headless (service pur)** : les deux sont des options
valides selon le contexte, ni l'une ni l'autre n'est imposée par ce lot -
un poste de travail normal qui sert aussi de serveur au cabinet peut très
bien rester en mode Tauri (icône, fenêtre) ; un mini-PC dédié sans écran
branché en permanence est mieux servi par le mode service pur.

**Limite connue** : si la coquille Tauri est utilisée SUR le poste serveur
en mode réseau (au lieu du service pur), sa fenêtre pointe aujourd'hui vers
`http://127.0.0.1:{PORT}` en HTTP simple (comportement hérité du Lot 1,
`src-tauri/src/main.rs`) - une fois le backend basculé en HTTPS-only, cette
fenêtre ne pourra plus se connecter. Non corrigé dans ce lot (nécessiterait
une modification Rust non compilable dans cet environnement de
développement, voir "Ce qui a été réellement testé"). **Solution de
contournement immédiate** : sur le poste serveur, utiliser un navigateur
classique pointé sur `https://127.0.0.1:3000` plutôt que la fenêtre Tauri,
ou privilégier le mode service pur (recommandé de toute façon pour un vrai
rôle de serveur).

## Résilience réseau (IP qui change, mDNS)

### `aurore.local` (recommandé)

Publié automatiquement par le serveur au démarrage (voir
`network/mdnsAdvertise.ts`, `bonjour-service`) - fonctionne même après un
changement de box/IP, sans reconfiguration des postes clients. Certains
réseaux d'entreprise bloquent le multicast mDNS (port UDP 5353) : dans ce
cas, utiliser l'IP brute (solution de secours, toujours documentée et
affichée en complément, jamais en remplacement).

### IP fixe / réservation DHCP (alternative)

Pour un cabinet qui préfère une IP qui ne change jamais plutôt que de
dépendre de mDNS :

- **Réservation DHCP** (recommandé) : dans l'interface d'administration de
  la box/du routeur du cabinet, réserver une IP fixe pour l'adresse MAC du
  poste serveur (section généralement nommée "Bail DHCP", "Réservation
  d'adresse" ou "IP statique par appareil"). L'IP reste alors toujours la
  même, y compris après redémarrage du serveur ou de la box.
- **IP statique manuelle** (alternative) : configurer une IP fixe
  directement sur le poste serveur (Paramètres Windows > Réseau > propriétés
  de l'adaptateur > IPv4). Nécessite de choisir une IP hors de la plage
  distribuée automatiquement par le routeur, pour éviter un conflit.

### Après un changement de box/opérateur internet

1. Vérifier le profil réseau Windows de la nouvelle connexion (doit rester
   "Privé" - Windows classe parfois une nouvelle box comme "Public" par
   défaut) : `Get-NetConnectionProfile`.
2. Si nécessaire, reclassez le réseau en "Privé" (voir plus haut) puis
   ré-exécutez `firewall-rule.ps1` (idempotent, sans risque à rejouer).
3. `aurore.local` continue de fonctionner sans rien reconfigurer côté
   postes clients (vérifié empiriquement - voir plus bas).
4. L'IP brute affichée sur `setup-mode.html` se met à jour automatiquement
   à chaque consultation (détection en temps réel, jamais mise en cache) -
   si le cabinet utilise l'IP brute plutôt que `aurore.local`, la
   redistribuer aux postes clients après un changement de box.
5. Si le certificat HTTPS a été régénéré (le serveur le fait automatiquement
   si l'IP a changé depuis sa génération, voir `security/localTlsCertificate.ts`),
   réimporter le nouveau certificat sur les postes clients qui l'avaient
   importé définitivement (option 2 de `import-cert-instructions.md`).

## Dépannage réseau courant

| Symptôme | Cause probable | Solution |
|---|---|---|
| Page inaccessible depuis un poste client | Port bloqué par le pare-feu | Vérifier `Get-NetFirewallRule -DisplayName "Aurore*"` sur le serveur ; ré-exécuter `firewall-rule.ps1` |
| Page inaccessible malgré une règle pare-feu présente | Profil réseau reclassé "Public"/"Domaine" après un changement de box | `Get-NetConnectionProfile`, reclasser en "Privé", ré-exécuter `firewall-rule.ps1` |
| `aurore.local` ne résout pas | mDNS bloqué par le réseau (fréquent en environnement d'entreprise/VLAN) | Utiliser l'IP brute affichée sur `setup-mode.html` à la place |
| Avertissement de certificat à chaque session | Certificat non importé définitivement (option 1 utilisée) | Suivre l'option 2 de `import-cert-instructions.md` |
| Avertissement de certificat revenu après une coupure | IP du serveur a changé, certificat régénéré automatiquement | Réimporter le nouveau certificat (voir ci-dessus) |
| IP affichée incorrecte (VPN, interface inhabituelle) | Plusieurs interfaces réseau actives | Voir `config/deploymentMode.ts` (heuristique de détection) - déconnecter le VPN sur le poste serveur si possible, ou vérifier manuellement l'IP réelle du LAN (`ipconfig`) |
| Le mode choisi ne semble pas appliqué | Aurore n'a pas été redémarré après le choix | Fermer puis rouvrir Aurore (ou `Restart-Service Aurore` en mode service pur) |

## Ce qui a été réellement testé

Testé de bout en bout avec le **vrai point d'entrée** (`src/index.ts`,
`main()`), une **vraie base PostgreSQL portable** (bootstrap complet du Lot
2, avec les binaires PostgreSQL réels et un schéma sans `vector`, même
limite documentée que les Lots 2/2bis pour pgvector), et de **vraies
connexions HTTPS/mDNS** :

```
[demarrage] mode serveur reseau (Lot 6) : bind 0.0.0.0, HTTPS avec certificat local auto-signe.
[tls] certificat local existant reutilise (valide, couvre l'adresse actuelle).
[mdns] "aurore.local" publie sur le reseau local (port 3444).
Aurore backend demarre en mode reseau sur 0.0.0.0:3444 (HTTPS, test).
```

- **Non-régression standalone** : sans configuration explicite
  (`config.json` absent, cas du tout premier lancement), le serveur
  démarre en HTTP sur `127.0.0.1` exactement comme avant ce lot -
  `GET /api/network-info` confirme `setupComplete: false`, `https: false`.
- **Choix du mode** : `POST /api/network-info/mode` sans authentification
  tant que le setup n'a jamais été fait (bootstrap, comme l'activation de
  licence) ; **rejeté avec `401`** si retenté après coup sans session
  titulaire (vérifié : un deuxième `POST` après configuration initiale
  échoue proprement).
- **Bind réseau réel** : une fois configuré et redémarré, `https://127.0.0.1`
  **et** `https://<IP LAN réelle de la machine>` répondent tous les deux
  (`200` sur `/health`) - la deuxième adresse simule fidèlement l'accès
  depuis un second poste du même réseau, puisqu'elle passe par la même
  interface réseau physique qu'utiliserait une autre machine.
- **HTTPS strict** : une tentative de connexion en HTTP simple sur le même
  port échoue (`000`, connexion refusée) - confirmé qu'il n'existe aucun
  repli HTTP une fois le mode réseau actif.
- **Certificat correct** : vérifié via `openssl` et `node:tls` en
  interrogeant le vrai serveur - `subject=CN=aurore.local`,
  `subjectAltName` contient bien `DNS:aurore.local`, `DNS:localhost`,
  `IP:127.0.0.1` et l'IP LAN réelle.
- **mDNS réel** : une requête mDNS indépendante (`multicast-dns`), envoyée
  pendant que le vrai serveur Aurore tournait, a reçu une réponse
  `aurore.local -> <IP LAN réelle>`.
- **Résilience réseau simulée** : en modifiant manuellement le fichier de
  métadonnées du certificat pour simuler une IP différente de celle
  détectée (changement de box), un redémarrage a bien déclenché la
  régénération automatique du certificat pour la nouvelle IP (log
  `"l'adresse IP locale a change... regeneration necessaire"`).
- **Authentification préservée en mode réseau** : `GET /api/dossiers` sans
  cookie de session, via l'IP LAN en HTTPS, renvoie `401` - identique au
  mode standalone.
- **Licence (Lot 3) sans modification** : sans `LICENCE_BYPASS`, une route
  métier via l'IP LAN en HTTPS renvoie `403` avec le message licence
  attendu (`"Aucune licence active..."`) - `/api/licence/status` et
  `/api/network-info` restent accessibles, exactement le même comportement
  qu'en mode standalone (Lot 3), sans aucune duplication de logique.
- **Firewall** : script relu et validé syntaxiquement (parseur PowerShell,
  aucune erreur) ; les commandes en lecture seule (`Get-NetConnectionProfile`)
  ont été exécutées pour de vrai sur cette machine, révélant un cas réel
  intéressant - l'interface Wi-Fi de la machine de développement est
  classée **"Public"**, exactement le cas que le script est censé détecter
  et signaler avec l'avertissement approprié.

## Non testé dans cet environnement

- **`New-NetFirewallRule` en conditions réelles** (création effective de la
  règle) : nécessite les droits Administrateur, non disponibles dans cet
  environnement de développement (session non élevée, pas d'UAC
  interactif possible). Le script a été validé syntaxiquement et sa partie
  lecture seule testée pour de vrai (voir plus haut) - l'exécution complète
  reste à valider sur un poste avec droits admin avant mise en production.
- **NSSM / mode service pur** : nécessiterait de télécharger le binaire
  NSSM et de l'installer comme service Windows réel (droits admin
  également requis, plus un aller-retour redémarrage machine pour vérifier
  le démarrage sans session ouverte) - hors de portée de cet environnement.
  Le script a été validé syntaxiquement (parseur PowerShell).
- **Second poste physique réel** : cet environnement ne dispose que d'une
  seule machine. La connexion "depuis un second poste" a été simulée en
  interrogeant l'IP de l'interface LAN de la machine de développement
  elle-même (au lieu de `127.0.0.1`) - une preuve solide que le bind
  `0.0.0.0` fonctionne sur l'interface réseau physique, mais pas un test
  avec deux machines distinctes sur le même Wi-Fi.
- **Fenêtre Tauri en mode réseau** sur le poste serveur : limite documentée
  plus haut (nécessite une modification `main.rs` non compilable ici, même
  contrainte que les Lots 1/2 pour la partie Rust).
- **Wireshark / capture de trafic** : non disponible dans cet environnement
  - la preuve du chiffrement TLS a été apportée indirectement (négociation
  TLS réussie via `node:tls`/`openssl`, connexion HTTP simple refusée sur
  le même port) plutôt que par une capture de paquets.

## Architecture

```
server/src/config/
  deploymentMode.ts        lecture/ecriture config.json (standalone|reseau)
                            + detection IP LAN (getLocalNetworkAddress,
                            partagee par networkInfo.ts, mdnsAdvertise.ts
                            et localTlsCertificate.ts - une seule
                            implementation)

server/src/routes/
  networkInfo.ts             GET /api/network-info (public)
                              POST /api/network-info/mode (bootstrap sans
                              auth, puis proteger par requireAuth+requireAdmin)

server/src/network/
  mdnsAdvertise.ts            publication "aurore.local" (bonjour-service)

server/src/security/
  localTlsCertificate.ts      certificat auto-signe local (selfsigned),
                              regenere si l'IP change ou expire bientot

public/setup-mode.html + public/js/setup-mode.js
  ecran de premier lancement (choix standalone/reseau)

public/js/api.js (modifie)
  redirige vers setup-mode.html si le choix n'a jamais ete fait

installer/
  firewall-rule.ps1           ouverture du port, profil prive uniquement,
                              idempotent
  aurore-service-install.ps1  installation NSSM (mode service pur)
  import-cert-instructions.md procedure d'import du certificat cote client
```

`index.ts` reste le seul point qui orchestre tout cela : il lit
`effectiveDeploymentMode()` (jamais `env.HOST` directement en mode
desktop, pour ne jamais dépendre d'une variable d'environnement pour une
décision de sécurité), choisit `app.listen()` (HTTP, 127.0.0.1) ou
`https.createServer(...)` (HTTPS, 0.0.0.0) en conséquence, et démarre/arrête
la publication mDNS en même temps que le reste du cycle de vie du serveur
(voir `gracefulShutdown()`).
