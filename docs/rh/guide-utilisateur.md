# Module RH Cabinet - Guide utilisateur

Ce guide s'adresse aux personnes qui utilisent le module RH au quotidien :
le **titulaire** du cabinet (qui gère tout), et les **avocats/collaborateurs**
(qui consultent et gèrent leurs propres informations). Il ne couvre pas les
détails techniques - voir `docs/rh/00-audit.md` pour les décisions
d'architecture.

## Qui peut faire quoi

Le module RH suit une règle simple : **le titulaire gère tout le personnel
du cabinet**, et **chaque avocat/collaborateur ne voit et ne gère que sa
propre fiche**. Il n'existe pas aujourd'hui de délégation fine (par
exemple : un avocat associé qui gérerait les congés sans être titulaire).
Si ce besoin se présente, il faudra en discuter avant de l'ajouter.

Le module RH se compose de deux briques, activables séparément par
l'administrateur de la plateforme :
- **« Personnel »** (fiches, stages, congés, planning) ;
- **« Paie »** (fiches de paie, état de paiement) - peut être désactivée
  même si « Personnel » reste actif, par exemple si le cabinet gère la paie
  ailleurs.

Si un écran affiche *"Ce module n'est pas activé pour votre cabinet"* ou
*"...pour ton compte"*, contactez respectivement l'administrateur de la
plateforme ou le titulaire du cabinet.

## 1. Personnel

**Écran : Personnel** (liste), **Fiche personnel** (détail).

Le titulaire ajoute chaque employé avec son nom, sa catégorie (avocat,
collaborateur, stagiaire, secrétariat, comptable, autre), son type de
contrat (CDI, CDD, stage, libéral, autre) et sa date d'entrée. Un employé
peut être rattaché à un **compte Aurore existant** (pour qu'il puisse se
connecter et voir sa propre fiche) ou rester une fiche "papier" sans
connexion (par exemple pour une personne qui n'utilise pas Aurore).

Un employé qui quitte le cabinet n'est jamais supprimé : le titulaire le
marque **"sorti"** avec une date de sortie. Il reste visible dans
l'historique (filtre "Tous" sur la liste) mais disparaît de la liste
active et n'est plus proposé lors des opérations courantes (nouvelle
période de paie, planning de congés...).

Les coordonnées de paiement (numéro de compte, mobile money...) et le
contact d'urgence sont des informations sensibles : elles sont chiffrées
en base de données et ne sont jamais affichées dans les journaux d'audit.

## 2. Stages

**Écran : Stages**, section "Stage" sur la fiche personnel.

Un stage a une date de début, une date de fin prévue et un **responsable**
(obligatoirement une personne avec un compte Aurore actif, pour qu'elle
puisse être prévenue). Aurore envoie automatiquement un rappel au
responsable à **J-30, J-15, J-7 et le jour de l'échéance**, puis une alerte
quotidienne si le stage reste ouvert au-delà de la date prévue. Ces
rappels sont envoyés même si l'application a été fermée pendant plusieurs
jours : au redémarrage, les rappels manqués sont rattrapés en une seule
fois, jamais en double.

Pour **prolonger** un stage, ouvrez-le et indiquez la nouvelle date de fin
(et éventuellement un motif) : les rappels futurs sont recalculés sur la
nouvelle échéance. Pour le **clôturer** (terminé ou interrompu), utilisez
le bouton correspondant - plus aucun rappel n'est envoyé ensuite. Le
titulaire et le responsable du stage peuvent tous les deux prolonger ou
clôturer.

## 3. Congés et absences

**Écrans : Mes congés** (tout le monde), **Validation des congés**
(titulaire), **Absences de l'équipe** (calendrier, tout le monde),
**Paramètres congés** (titulaire).

Chaque employé pose sa demande depuis "Mes congés" : type d'absence (congé
annuel, maladie, etc. - personnalisables depuis "Paramètres congés"),
dates de début/fin, et éventuellement une demi-journée en début ou fin de
période. Le nombre de jours ouvrés est calculé automatiquement (jours
fériés et samedi travaillé ou non, selon le réglage du cabinet).

Le titulaire valide ou refuse chaque demande depuis "Validation des
congés" ; l'employé est notifié de la décision. Une demande encore **en
attente** peut être annulée par son auteur ; une demande déjà traitée ne
peut être annulée que par le titulaire.

Le calendrier d'équipe ("Absences de l'équipe") montre qui est absent et
quand, mais **jamais le motif ni le type d'absence** - uniquement la
mention "Absent". C'est une règle de confidentialité volontaire : le
motif d'une absence (maladie, raison familiale...) ne doit être visible
que par la personne concernée et le titulaire.

## 4. Planning automatique de congés

**Écran : Planning de congés** (titulaire), section "Mes souhaits" sur
"Mes congés" (employés).

Chaque employé indique jusqu'à 3 souhaits de dates de congé pour l'année,
par ordre de préférence. Le titulaire lance ensuite la génération du
planning en précisant l'effectif minimum à garder au cabinet à tout
moment et les périodes à éviter (ex : grosses échéances). L'algorithme
essaie de satisfaire le souhait n°1 de chacun, puis n°2, puis n°3 ; si
aucun des trois n'est possible, il cherche la date la plus proche
disponible. Il évite aussi qu'un avocat parte en même temps qu'une
audience sur un de ses dossiers (le lien "avocat responsable" du dossier
doit être renseigné pour que cette vérification fonctionne).

Le planning généré reste **modifiable manuellement** (le titulaire peut
ajuster une ligne) et **régénérable** tant qu'il n'est pas validé. Une
fois validé, chaque ligne placée devient une demande de congé déjà
approuvée pour l'employé concerné, qui en est notifié - le planning
lui-même ne peut alors plus être modifié ni régénéré.

## 5. Paie

**Écran : Paie du mois** (titulaire), **Mes fiches de paie** (employés),
section "Éléments de salaire" sur la fiche personnel.

Avant de générer une paie, le titulaire configure les **éléments de
salaire** de chaque employé (salaire de base, primes, retenues...) : un
montant fixe, ou un pourcentage du salaire de base ou du brut. Un seul
élément par fiche peut être marqué "salaire de base" - il sert de
référence pour les calculs en pourcentage et pour la retenue en cas
d'absence non rémunérée.

Pour générer les fiches d'un mois, le titulaire ouvre la période depuis
"Paie du mois" (un mois au format année-mois) : une fiche en **brouillon**
est créée pour chaque employé actif, avec son calcul automatique. Le
titulaire peut ajouter un **ajustement ponctuel** (prime ou retenue
exceptionnelle pour ce mois précis) tant que la fiche reste en brouillon -
Aurore refuse toujours une modification qui ferait passer le net à payer
sous zéro.

**Valider** une fiche la fige définitivement : elle reçoit un numéro, un
PDF est généré (ce document précise explicitement qu'il doit être soumis
au comptable du cabinet - Aurore ne remplace pas la paie officielle), et
plus aucune modification n'est possible. Si une erreur est découverte
après coup, le titulaire **annule** la fiche (avec un motif obligatoire) :
l'ancienne version est conservée telle quelle dans l'historique, et une
nouvelle version en brouillon est créée pour correction.

Chaque employé consulte et télécharge ses propres fiches **validées**
uniquement depuis "Mes fiches de paie" - jamais les brouillons, ni celles
des autres.

## 6. État de paiement mensuel

**Écran : Paie du mois**, section "État de paiement" (titulaire
uniquement).

Une fois les fiches de paie d'un mois validées, le titulaire génère
l'état de paiement correspondant : un récapitulatif avec une ligne par
fiche validée, un mode de paiement et un statut ("à payer" / "payé"). Cet
état peut être régénéré tant qu'il n'est pas validé - par exemple si une
fiche supplémentaire est validée entre-temps - sans jamais perdre les
paiements déjà marqués comme effectués.

Le titulaire marque chaque ligne "payée" avec la date et une référence de
paiement (numéro de virement, par exemple), au fur et à mesure des
paiements réels effectués en dehors d'Aurore - **Aurore n'effectue aucun
paiement**, il s'agit uniquement d'un registre de suivi. Une fois l'état
**validé**, il devient définitif et la période de paie correspondante est
clôturée : plus aucune ligne ne peut être modifiée.

Deux formats d'export sont disponibles depuis l'état validé : un **PDF**
(pour archivage/impression) et un **CSV** (compatible Excel, pour
rapprochement comptable).

## Confidentialité et traçabilité

Toute action significative (création/modification de fiche, décision sur
une demande de congé, validation d'une fiche de paie...) est enregistrée
dans un journal d'audit consultable par le titulaire, avec qui a fait
quoi et quand. Ce journal ne contient jamais de montant ni de contenu
sensible (motif d'absence, coordonnées de paiement) - uniquement le nom de
l'action effectuée.
