# Faire confiance au certificat Aurore sur un poste client

En mode "Serveur réseau" (Lot 6), Aurore chiffre le trafic entre le
serveur et les postes du cabinet avec un certificat **auto-signé**, généré
automatiquement sur le poste serveur. Ce n'est **pas** un certificat émis
par une autorité publique reconnue (comme pour un site internet) : votre
navigateur ne peut donc pas vérifier automatiquement son authenticité, et
affiche un avertissement de sécurité la première fois que vous accédez à
Aurore depuis un nouveau poste.

## Pourquoi cet avertissement n'est pas un vrai risque ici

Sur un site internet public, ce type d'avertissement peut signaler une
tentative d'interception malveillante (quelqu'un se faisant passer pour le
site). **Ici, c'est différent** : ce certificat a été généré **par le
serveur Aurore de votre propre cabinet**, sur votre propre réseau local -
il n'y a pas de tiers externe impliqué. L'avertissement apparaît uniquement
parce que ce certificat n'est pas signé par une des autorités publiques
que votre navigateur connaît déjà (Let's Encrypt, DigiCert...), pas parce
qu'il y a un problème de sécurité réel.

Cela dit, ne "cliquez pour ignorer" que si vous êtes sûr de vous connecter
à l'adresse de **votre propre serveur Aurore** (`https://aurore.local` ou
l'IP indiquée par le cabinet) - jamais à une adresse inconnue qui
afficherait le même type d'avertissement.

## Option 1 - Faire confiance une fois par navigateur (rapide, à refaire occasionnellement)

À la première connexion, votre navigateur affiche une page d'avertissement
("Votre connexion n'est pas privée", "Ce certificat n'est pas fiable"...).

- **Chrome / Edge** : cliquer sur "Paramètres avancés" (ou "Détails"), puis
  "Continuer vers [adresse] (dangereux)" / "Continuer vers le site".
- **Firefox** : cliquer sur "Avancé...", puis "Accepter le risque et
  poursuivre".

Cette confiance est mémorisée par le navigateur, mais peut être redemandée
après un vidage du cache/des données de navigation, ou une réinstallation
du navigateur.

## Option 2 - Importer le certificat une fois pour toutes (recommandé)

Élimine l'avertissement définitivement sur ce poste, pour tous les
navigateurs à la fois (le magasin de certificats est partagé au niveau de
Windows).

1. Récupérer le fichier de certificat depuis le poste serveur :
   `%APPDATA%\Aurore\secrets\tls\aurore-cert.pem`
   (le transmettre par clé USB ou partage réseau du cabinet - **ce fichier
   ne contient pas la clé privée**, il ne pose aucun problème à partager).
2. Sur le poste client, double-cliquer sur le fichier `aurore-cert.pem`
   (renommer temporairement en `.crt` si Windows ne propose pas
   l'assistant d'importation directement).
3. Cliquer sur "Installer le certificat..."
4. Choisir **"Ordinateur local"** (nécessite les droits administrateur -
   une fenêtre de confirmation Windows peut apparaître).
5. Choisir **"Placer tous les certificats dans le magasin suivant"**, puis
   "Parcourir..." et sélectionner **"Autorités de certification racines de
   confiance"**.
6. Terminer l'assistant, confirmer l'avertissement de sécurité final de
   Windows (normal : vous importez volontairement un certificat que vous
   reconnaissez).
7. Fermer et rouvrir le navigateur, puis retourner sur Aurore : l'avertissement
   ne doit plus apparaître.

### Via PowerShell (équivalent, en ligne de commande, Administrateur requis)

```powershell
Import-Certificate -FilePath "\\chemin\vers\aurore-cert.pem" -CertStoreLocation "Cert:\LocalMachine\Root"
```

## Si le certificat a été régénéré (changement d'IP, expiration)

Le serveur régénère automatiquement un nouveau certificat s'il a changé de
réseau local (nouvelle IP) ou si l'ancien certificat approche de son
expiration (voir `README-LOT6.md`). Dans ce cas, l'ancien certificat importé
sur les postes clients n'est plus reconnu : répéter la procédure
d'importation avec le nouveau fichier `aurore-cert.pem`.
