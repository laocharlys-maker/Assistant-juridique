# Faire confiance à Aurore sur un poste client (une seule fois)

En mode "Serveur réseau", Aurore chiffre le trafic entre le serveur et les
postes du cabinet (HTTPS). Elle crée pour cela sa **propre autorité de
certification locale** ("Aurore - Autorité locale"), qui signe le certificat
du serveur. Ce n'est pas une autorité publique (Let's Encrypt, DigiCert...) :
tant qu'un poste ne la connaît pas, son navigateur affiche un avertissement.

**Il suffit d'importer cette autorité UNE SEULE FOIS sur chaque poste.** Le
certificat du serveur peut ensuite être renouvelé ou régénéré (nouvelle
adresse IP, expiration) sans que les postes aient quoi que ce soit à refaire :
ils font confiance à l'autorité, pas au certificat du serveur.

## Pourquoi cet avertissement n'est pas un vrai risque ici

Le certificat a été créé **par le serveur Aurore de votre propre cabinet**,
sur votre propre réseau : aucun tiers externe n'est impliqué. L'avertissement
apparaît uniquement parce que l'autorité n'est pas encore connue du poste.
Ne "passez outre" que pour l'adresse de **votre propre serveur Aurore**
(`https://aurore.local:3000` ou l'IP indiquée par le cabinet).

## Méthode simple (recommandée) : le dossier POUR-LES-POSTES

Aurore prépare automatiquement, sur le serveur, un dossier prêt à copier :

`%APPDATA%\Aurore\secrets\tls\POUR-LES-POSTES`

1. Copiez **tout ce dossier** sur une clé USB (il ne contient aucune clé privée).
2. Sur chaque poste : double-clic sur **Installer-certificat-Aurore.bat**
   (acceptez la demande d'administrateur). Le script supprime les anciens
   certificats Aurore, installe l'autorité et affiche
   `OK : CN=Aurore - Autorite locale ... valable jusqu'au ...` (environ 10 ans).
3. Fermez **complètement** le navigateur (Chrome, Edge...) puis rouvrez-le.

**N'installez jamais `aurore-cert.pem` ni un fichier `aurore-cert.crt`** : ce
sont des certificats du serveur (valables 2 ans, remplacés régulièrement), pas
l'autorité. Si, après installation, la validité affichée est de 2 ans, vous
avez installé le mauvais fichier : refaites l'opération avec le dossier
`POUR-LES-POSTES`. Firefox utilise son propre magasin : utilisez Chrome ou Edge.

## Adresse à utiliser dans le navigateur

`aurore.local` repose sur le protocole mDNS, souvent bloqué par la box ou le
pare-feu : **ne comptez pas dessus**. Utilisez plutôt, par ordre de fiabilité :

1. **Le nom Windows du PC serveur** : `https://NOM-DU-PC:3000` (ex.
   `https://desktop-c89vobu:3000`). Il suit automatiquement l'adresse IP du PC,
   et le certificat le couvre. Conseil : renommer le PC serveur en `AURORE`
   (Paramètres, Système, Informations système, Renommer ce PC) pour obtenir
   `https://aurore:3000`.
2. L'adresse IP du serveur : `https://192.168.x.x:3000`.

## Méthode manuelle (si le dossier n'est pas disponible)

### 1. Récupérer le fichier sur le serveur

Fichier : `%APPDATA%\Aurore\secrets\tls\aurore-ca.crt`

Copiez-le sur une clé USB ou un partage du cabinet. **Il ne contient aucune
clé privée** : le partager ne pose aucun problème. Ne copiez jamais les
fichiers `*-key.pem`.

### 2. L'importer sur chaque poste client (PowerShell en administrateur)

```powershell
Import-Certificate -FilePath "C:\chemin\vers\aurore-ca.crt" -CertStoreLocation Cert:\LocalMachine\Root
```

Ou par l'interface : double-clic sur `aurore-ca.crt`, "Installer le
certificat...", **"Ordinateur local"**, "Placer tous les certificats dans le
magasin suivant", **"Autorités de certification racines de confiance"**.

### 3. Vérifier

```powershell
certutil -store root "Aurore - Autorite locale"
```

Fermer complètement le navigateur, le rouvrir, puis aller sur Aurore :
l'avertissement ne doit plus apparaître.

## Si un ancien certificat Aurore (`aurore.local`) est déjà installé

Les versions précédentes demandaient d'importer `aurore-cert.pem`, qui changeait
à chaque régénération. Il n'est plus utile : le supprimer évite toute confusion.

```powershell
Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -like "*aurore.local*" | Format-List Subject, NotBefore, Thumbprint
Remove-Item Cert:\LocalMachine\Root\EMPREINTE
```

(remplacer `EMPREINTE` par le `Thumbprint` affiché).

## Quand faut-il réimporter ?

Presque jamais. Seulement si l'**autorité** elle-même est recréée :

- le dossier `%APPDATA%\Aurore\secrets\tls` du serveur est supprimé, ou Aurore
  est réinstallée sur un autre PC serveur ;
- l'autorité approche de son expiration (validité de 10 ans, renouvelée 90 jours
  avant la fin).

Un changement d'adresse IP du serveur, un redémarrage, un changement de Wi-Fi
ou Tailscale qui se connecte/déconnecte **ne nécessitent aucune action** sur
les postes.

## Sauvegarde

Sauvegardez le dossier `%APPDATA%\Aurore\secrets\tls` (en particulier
`aurore-ca.pem` et `aurore-ca-key.pem`) avec les autres secrets du serveur :
si le serveur est remplacé, restaurer ce dossier évite de réimporter
l'autorité sur tous les postes.
