# Checklist BitLocker - installation Aurore (Lot 2bis)

Aurore chiffre au repos les champs sensibles de sa base de donnees (voir
[README-LOT2BIS.md](../README-LOT2BIS.md)), mais cette protection est
**complementaire**, pas suffisante seule : elle ne couvre ni le reste du
disque (fichiers exportes en Word/PDF, sauvegardes `pg_dump`), ni le fichier
contenant la cle de chiffrement elle-meme si le disque n'est pas chiffre. En
cas de vol ou perte physique du PC/serveur du cabinet, seul le chiffrement
de disque complet (BitLocker) protege l'ensemble.

Ceci est une **checklist**, pas une etape automatisee de l'installeur : son
activation touche a la configuration systeme du poste (droits admin,
redemarrage, cle de recuperation a sauvegarder ailleurs), ce qui doit rester
une decision explicite de la personne qui installe Aurore, jamais silencieuse.

## A faire a l'installation (ou avant, idealement)

1. Verifier l'edition Windows : BitLocker necessite **Windows Pro,
   Enterprise ou Education** (absent de Windows Home - voir alternative
   ci-dessous).
2. Verifier l'etat actuel :
   ```
   powershell -ExecutionPolicy Bypass -File installer\enable-bitlocker.ps1
   ```
   (diagnostic seul, ne modifie rien)
3. Si BitLocker n'est pas actif, l'activer :
   - **Via l'interface Windows** (recommande pour une premiere activation,
     plus visuel) : Panneau de configuration > Systeme et securite >
     Chiffrement de lecteur BitLocker > Activer BitLocker sur le lecteur
     systeme (C:).
   - **Ou via le script**, qui guide les memes etapes avec confirmation :
     ```
     powershell -ExecutionPolicy Bypass -File installer\enable-bitlocker.ps1 -Enable
     ```
4. **Sauvegarder la cle de recuperation** generee lors de l'activation, sur
   un support DIFFERENT de ce PC : cle USB dediee rangee au cabinet, compte
   Microsoft de l'administrateur du poste, ou imprimee et rangee en lieu
   sur. Sans cette cle, un probleme materiel (carte mere changee, disque
   deplace vers un autre PC) rend le disque **definitivement illisible**.
5. Laisser le chiffrement initial du disque se terminer en arriere-plan
   (peut prendre plusieurs heures sur un disque volumineux - l'ordinateur
   reste utilisable pendant ce temps).

## Windows Home (BitLocker indisponible)

Pas de BitLocker sur Windows Home. Alternatives, par ordre de preference :
- Mettre a niveau vers Windows 11 Pro (mise a niveau payante mais simple
  depuis Windows Home, sans reinstallation).
- A defaut, chiffrer au minimum le dossier de donnees Aurore
  (`%APPDATA%\Aurore`, qui contient la cle de chiffrement, les identifiants
  Postgres et les sauvegardes) avec un outil tiers de chiffrement de
  conteneur (ex: VeraCrypt) - protection partielle, moins robuste qu'un
  chiffrement de disque complet.

## Ce que BitLocker protege - et ce qu'il ne protege pas

- **Protege** : le contenu du disque en cas de vol/perte du PC eteint ou
  verrouille (donnees illisibles sans le mot de passe Windows/la cle de
  recuperation).
- **Ne protege PAS** : un acces alors que le PC est allume et deverrouille
  (BitLocker dechiffre automatiquement une fois la session ouverte) - c'est
  le role du chiffrement applicatif des champs sensibles (Lot 2bis) et des
  comptes/mots de passe Aurore eux-memes.

Les deux mecanismes sont donc complementaires, pas redondants.
