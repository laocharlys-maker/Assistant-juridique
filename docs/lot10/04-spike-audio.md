# Prompt 4, étape 0 — Spike de faisabilité : enregistrement audio écran verrouillé

## Pourquoi ce document existe

Le prompt 4 impose de trancher *avant* de construire l'enregistrement complet
(repères, compression finale, reprise après coupure, etc.) : est-ce qu'on
peut enregistrer de l'audio de façon fiable sur Android avec l'écran
verrouillé et l'application en arrière-plan, pendant 15 à 30 minutes,
sur des téléphones très différents (dont de l'entrée de gamme) ?

Je ne peux pas faire tourner un téléphone Android moi-même. Ce document fait
donc deux choses séparées :
1. Une comparaison **théorique**, basée sur le fonctionnement documenté
   d'Android, des deux approches possibles — pour expliquer pourquoi une
   seule a été retenue et codée.
2. Un **APK de test** (branche `lot10-04-mobile-audio`) qui implémente
   l'approche retenue, à faire tourner réellement sur au moins deux marques
   de téléphones (dont une d'entrée de gamme) selon le protocole ci-dessous.
   **La validation réelle reste à faire par vous.**

## Les deux options comparées

### Option 1 — API d'enregistrement Expo seule (expo-av / expo-audio), sans service de premier plan

C'est l'option la plus simple à coder, mais elle ne déclare aucun **service
de premier plan** (foreground service) auprès du système Android. Or :

- Android impose depuis longtemps des limites d'exécution en arrière-plan
  (Doze, App Standby) qui peuvent suspendre ou tuer un processus
  d'application ordinaire au bout de quelques minutes, surtout écran
  verrouillé.
- Plusieurs constructeurs (Xiaomi/MIUI, Huawei, Samsung, OnePlus...)
  ajoutent leurs propres gestionnaires de batterie, nettement plus agressifs
  que le comportement Android standard, documentés de façon indépendante sur
  des sites comme dontkillmyapp.com - connus pour tuer des apps en
  arrière-plan même quand elles respectent les règles Android standard.
- Cette option ne fournit pas non plus la **notification permanente**
  exigée par le prompt (objectif A) : sans service de premier plan, il n'y a
  rien pour porter cette notification.

**Conclusion** : insuffisant par construction pour l'exigence du prompt
(30 min, écran verrouillé, notification permanente). Non retenue seule.

### Option 2 — Service de premier plan natif (foreground service, type « microphone »)

C'est le mécanisme qu'Android documente lui-même comme la façon correcte de
faire tourner un enregistrement audio en arrière-plan : le service déclare
`android:foregroundServiceType="microphone"`, affiche une notification
permanente (obligatoire, pas optionnelle - c'est ce qui protège le
processus d'être tué), et continue de tourner tant que l'utilisateur ne
l'arrête pas. C'est le mécanisme utilisé par les applications
d'enregistrement vocal du marché.

Elle ne supprime pas 100 % du risque : si un constructeur va jusqu'à tuer le
processus entier malgré le service de premier plan (certains gestionnaires
de batterie très agressifs le font), rien ne peut empêcher ça depuis
l'application elle-même - seul un réglage utilisateur («autoriser en
arrière-plan», désactiver l'optimisation de batterie pour l'app) y change
quelque chose. C'est précisément ce que le test réel doit mesurer marque par
marque.

**Conclusion : option retenue.** Codée dans `mobile/modules/audio-spike/`
(module Expo local, Kotlin), exposée au JS via l'écran interne
« Spike audio » (Réglages → Spike audio (test interne)).

## Ce que l'APK de test fait concrètement

- Démarre un `android.media.MediaRecorder` (AAC, 32 kbit/s, 44.1 kHz - ordre
  de grandeur visé pour l'objectif A : 10 à 15 Mo/heure) à l'intérieur d'un
  service de premier plan avec notification permanente générique (« Aurore
  Mobile — enregistrement en cours », sans aucun contenu de dossier).
- Écrit en parallèle un fichier « battements de cœur » : une ligne
  d'horodatage ajoutée chaque seconde, tant que le service est vivant. C'est
  la mesure objective de fiabilité : si le service ou le processus est tué,
  les battements s'arrêtent ou présentent un trou - ça se voit dans l'écart
  maximum entre deux battements, affiché à l'arrêt du test.
- À l'arrêt du test, l'écran affiche : durée du test, taille du fichier
  audio produit, nombre de battements reçus vs attendus, écart maximum entre
  deux battements (> 2 secondes = coupure probable à investiguer).

Ce code est volontairement jetable et minimal : pas de chiffrement, pas de
pause/reprise, pas de reprise après coupure brutale, pas de repères - tout
ça appartient aux objectifs A à D du prompt 4, qui ne démarrent qu'après
votre validation de cette étape 0.

## Protocole de test demandé (à faire vous-même, sur au moins 2 marques dont une d'entrée de gamme)

Pour chaque téléphone, dans l'écran « Spike audio » (Réglages → Spike audio) :

1. Appuyer sur « Démarrer le test ».
2. Verrouiller l'écran immédiatement, poser le téléphone, laisser tourner
   **15 minutes** sans y toucher.
3. Pendant ce temps si possible : provoquer un appel entrant, faire tourner
   l'écran (si déverrouillé un instant), activer l'économiseur de batterie.
4. Déverrouiller, rouvrir l'app, appuyer sur « Arrêter le test ».
5. Noter le résultat affiché (durée, taille, battements, écart maximum).
6. Si le premier essai est concluant, refaire un essai de **30 minutes**
   dans les mêmes conditions (critère d'acceptation du prompt).
7. Si le résultat montre une coupure (écart > 2 s ou fichier anormalement
   petit), noter la marque/modèle et, si possible, si un réglage « autoriser
   en arrière-plan » ou « désactiver l'optimisation de batterie » existe
   pour l'app et si l'activer résout le problème.

**Merci de me rapporter, par téléphone testé : marque/modèle, résultat
(durée réussie, écart maximum, taille du fichier), et tout réglage batterie
qu'il a fallu changer.** Je n'autorise la suite du prompt 4 (objectifs A à
D : enregistrement complet, repères, mode « Après audience ») qu'après ce
retour, conformément à la consigne du prompt.

## Limites déjà connues, indépendamment du test

- Le fichier produit par ce spike n'est **pas chiffré** (contrairement à
  l'exigence finale de l'objectif A) - normal, ce n'est pas l'objet de ce
  test.
- Si le processus est tué malgré le service de premier plan, le fichier
  audio partiel reste sur le disque (MediaRecorder écrit en continu), mais
  ce spike ne tente pas de le « récupérer » proprement comme l'exigera
  l'objectif A - il sert seulement à mesurer si la coupure se produit.
- `minSdkVersion` du projet est 29 (Android 10). Le spike n'a pas été
  adapté pour des versions antérieures ; si un téléphone de test est plus
  ancien, il faudra le signaler.
