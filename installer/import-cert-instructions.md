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

## Étapes

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
