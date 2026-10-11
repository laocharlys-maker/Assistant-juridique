# Prompt 5, objectif A — Vérification écrite du choix de bibliothèque de scan

## Ce que le prompt exige

> Choisis la bibliothèque APRÈS une vérification écrite : le traitement doit
> se faire entièrement sur l'appareil, sans envoi de l'image ni télémétrie
> vers un tiers, et l'image ne doit jamais passer par la galerie du
> téléphone. Si la bibliothèque candidate ne le garantit pas, propose une
> alternative [...] et explique le compromis.

Deux barres à franchir, séparément : (1) aucune image envoyée, **et** (2)
aucune télémétrie. Les deux doivent être vraies en même temps.

## Candidats trouvés (recherche web, 2026-10-11)

Presque toutes les bibliothèques React Native de scan de documents encore
maintenues sont de simples enrobages (« wrappers ») autour de deux API
propriétaires : **Google ML Kit Document Scanner** (Android) et **Apple
VisionKit** (iOS) — ex. `react-native-document-scanner-plugin`,
`@dariyd/react-native-document-scanner`. Aurore Mobile ne cible qu'Android
(`app.json`, `platforms: ["android"]`), donc seule l'API Google compte ici.
Les quelques bibliothèques 100% OpenCV indépendantes de ML Kit
(`react-native-document-scanner` d'origine, `ubidreams/react-native-document-scanner`)
sont abandonnées depuis 2017-2019 ou explicitement « work in progress,
looking for contributors » — pas un choix raisonnable pour une fonctionnalité
livrée aujourd'hui.

## Vérification de Google ML Kit Document Scanner

Source officielle : [developers.google.com/ml-kit/terms](https://developers.google.com/ml-kit/terms).

Citation exacte :

> When you use ML Kit APIs, processing of the input data (e.g. images,
> video, text) fully happens on-device, and ML Kit does not send that data
> and the resultant outputs to Google servers.

→ **Barre 1 (image jamais envoyée) : remplie.** C'est une garantie écrite de
Google lui-même, pas une déduction.

Mais la même page continue :

> The ML Kit APIs also send metrics about the performance and utilization
> of the APIs in your app to Google [...] to measure performance, debug,
> maintain and improve the APIs, and detect misuse or abuse. **You are
> responsible for informing users of your app about Google's processing of
> ML Kit metrics data.**

→ **Barre 2 (aucune télémétrie) : non remplie.** Il y a bien un envoi de
télémétrie vers Google à chaque utilisation de l'API, documenté comme tel,
avec une obligation de transparence explicitement renvoyée au développeur.

**Conclusion : Google ML Kit Document Scanner ne passe pas la vérification
telle que le prompt l'exige.** L'image reste locale, mais ce n'est qu'une
des deux conditions. Pas retenu, conformément à la consigne « si la
bibliothèque candidate ne le garantit pas, propose une alternative ».

(Détails annexes trouvés pendant la recherche, sans incidence sur la
décision : l'import depuis la galerie est un réglage — `setGalleryImportAllowed(false)`
désactive l'option mais ne garantit rien sur la télémétrie ; l'API exige au
moins 1,7 Go de RAM sur l'appareil, ce qui aurait de toute façon exclu
certains téléphones d'entrée de gamme visés par le critère d'acceptation.)

## Alternative retenue : construite sur mesure, sans aucune dépendance de scan tierce

Même principe déjà appliqué au Prompt 4 pour l'enregistrement audio
(`mobile/modules/audio-recorder/`) : quand aucune bibliothèque externe ne
peut être garantie par écrit, le code critique est écrit directement avec
les briques déjà présentes dans le projet ou strictement standard, donc
entièrement vérifiable soi-même plutôt que de confier le résultat à un tiers.

| Étape | Choix | Pourquoi ça passe la vérification |
|---|---|---|
| Capture caméra | `expo-camera` (déjà une dépendance du projet, utilisée pour le QR d'appairage) | Capture une photo en mémoire/fichier app-privé ; aucune galerie, aucun réseau. |
| Détection des bords | **Semi-automatique** : un cadre-guide affiché à l'écran pendant la prise de vue, puis 4 poignées aux coins de la photo que l'utilisateur peut ajuster (préremplies à une estimation raisonnable, pas de détection par IA) | Aucune bibliothèque de vision/ML tierce = rien à vérifier côté réseau/télémétrie, car il n'y a pas de dépendance. Compromis explicite ci-dessous. |
| Redressement (perspective) | Transformation de perspective à 4 points via `android.graphics.Matrix.setPolyToPoly` + `Canvas`, dans un petit module natif Kotlin (même dossier `mobile/modules/`, même pattern que l'enregistreur audio) | API Android standard (SDK Android lui-même), zéro dépendance tierce, code lisible et versionné dans le repo. |
| Assemblage PDF multipage | `pdf-lib` (bibliothèque JS pure, open-source, aucun appel réseau — construit le PDF entièrement en mémoire à partir des JPEG déjà redressés) | Code source consultable, aucune télémétrie documentée ni trouvée, aucune dépendance native. |
| Réordonnancement / suppression de page | État React simple côté JS (liste de pages en mémoire avant assemblage final) | Pas de bibliothèque supplémentaire. |

### Compromis assumé

Sans ML Kit, il n'y a **pas de détection automatique des bords par
intelligence artificielle** — l'utilisateur ajuste lui-même les 4 coins
(préremplis à une estimation simple basée sur les bords de la photo, pour
rester rapide). C'est une étape manuelle de plus par page, mais :
- elle reste rapide (glisser 4 poignées, quelques secondes),
- elle est strictement plus fiable qu'une détection automatique ratée sur un
  fond compliqué (table en bois, document froissé...),
- c'est le seul moyen de respecter les deux barres du prompt en même temps
  avec un cadre Android uniquement.

### Stockage (objectif D du prompt)

Photos temporaires et PDF final écrits dans le cache privé de l'application
(jamais `MediaStore`/galerie), chiffrés avec le même coffre que l'audio
(`vault/vault.ts`, AES-256-GCM) avant d'être déposés dans le dossier
`DOSSIER_RACINE` déjà utilisé par l'audio — mêmes garanties, même mécanisme,
pas de nouveau composant de chiffrement à auditer.

## Vérification de la contrainte "aucune image dans la galerie"

Puisqu'aucune étape de ce pipeline n'appelle `MediaStore.Images`,
`Intent.ACTION_MEDIA_SCANNER_SCAN_FILE`, ni aucune galerie système, et que
toutes les lectures/écritures passent par le cache privé de l'app
(`Paths.cache`/`Paths.document`, comme `recorder.ts`), aucune image ne peut
apparaître dans la galerie ou Google Photos par construction — pas besoin
d'un réglage à désactiver, il n'y a simplement aucun chemin de code qui y
écrit. Vérifiable par l'utilisateur au critère d'acceptation (recherche dans
Google Photos après un scan de test).
