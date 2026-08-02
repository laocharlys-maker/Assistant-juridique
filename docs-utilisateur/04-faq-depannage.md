# Questions fréquentes et dépannage

## Aurore ne démarre pas / rien ne s'affiche

- Attendez quelques secondes après le double-clic sur l'icône — le tout
  premier démarrage après l'installation peut prendre jusqu'à 15-20
  secondes (préparation de la base de données interne). Les démarrages
  suivants sont beaucoup plus rapides (quelques secondes).
- Si rien ne s'affiche après une minute, fermez complètement Aurore
  (vérifiez dans le gestionnaire des tâches Windows qu'aucun programme
  "Aurore" ne reste actif) et relancez-le.
- Si le problème persiste, contactez AzoMedIA.

## J'ai oublié mon mot de passe

Contactez le titulaire de votre cabinet (la personne responsable du
compte principal) : depuis son propre compte, il peut réinitialiser votre
mot de passe dans le menu "Équipe".

## "Aucune licence active" alors que j'avais déjà activé la mienne

Cela peut arriver si vous utilisez un ordinateur différent de celui sur
lequel la licence a été activée — une licence est liée à un seul
ordinateur précis. Contactez AzoMedIA si vous devez la transférer.

## Message "Votre licence a expiré"

Deux cas possibles :

- **Un bandeau orange en haut de l'écran**, mais vous pouvez continuer à
  travailler normalement : vous êtes dans la période de grâce (quelques
  jours après l'expiration). Contactez AzoMedIA pour renouveler avant la
  fin de cette période.
- **Un blocage complet de l'application** : la période de grâce est
  dépassée. Contactez AzoMedIA pour recevoir un nouveau fichier de
  licence, puis suivez le guide `02-activation-licence.md`.

## Une mise à jour est proposée — dois-je l'installer ?

C'est recommandé (corrections, améliorations), mais jamais obligatoire
dans l'immédiat. Aurore vous demande toujours confirmation avant
d'installer quoi que ce soit — si vous cliquez "Non", l'application
continue de fonctionner normalement avec la version actuelle, et vous
proposera à nouveau la mise à jour plus tard.

## Mes documents/dossiers ont-ils un risque d'être perdus ?

Vos données sont enregistrées automatiquement sur l'ordinateur (ou le
poste "serveur" en mode réseau — voir `03-connexion-postes-reseau.md`),
avec des sauvegardes automatiques quotidiennes. En cas de doute sur une
manipulation (désinstallation, changement d'ordinateur), voir le guide
`05-desinstallation.md` avant d'agir.

## Un message d'avertissement de sécurité Windows apparaît à l'installation

C'est normal pour un logiciel récent — voir l'étape 1 du guide
`01-installation.md`.

## Un avertissement "connexion non privée" apparaît dans le navigateur (mode réseau)

C'est normal en mode "Serveur réseau" — voir l'étape 2 de la section
"Sur les autres ordinateurs du cabinet" dans `03-connexion-postes-reseau.md`.

## Je veux changer un réglage déjà fait (ex: passer de "Poste unique" à "Serveur réseau")

Reconnectez-vous en tant que titulaire du cabinet, puis retournez sur
l'écran de configuration (`http://127.0.0.1:3000/setup-mode.html`) — vos
choix précédents y sont déjà présélectionnés, vous pouvez les modifier.

## Je veux désinstaller Aurore

Voir le guide dédié `05-desinstallation.md` — il explique notamment
comment conserver vos données pour une réinstallation future si besoin.

---

Votre question n'est pas dans cette liste ? Écrivez à AzoMedIA, avec si
possible une description de ce que vous faisiez et le message exact
affiché à l'écran :

**azomedia20@gmail.com**
