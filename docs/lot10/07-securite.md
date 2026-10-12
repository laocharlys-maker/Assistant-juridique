# Prompt 7 — Rapport de sécurité et durcissement, Aurore Mobile

## Comment lire ce rapport

Chaque affirmation indique **comment elle a été vérifiée** :
- **Vérifié par lecture du code** : le fichier/la ligne exacte est cité, n'importe qui peut relire la même chose.
- **Vérifié par test automatisé** : un test existe dans le dépôt et passe (nom du test cité).
- **À tester par l'utilisateur** : vérifiable uniquement avec un vrai appareil Android physique (je n'en ai pas pendant cette session) — procédure exacte donnée, jamais affirmé comme fait sans preuve.
- **Non vérifiable de façon fiable, documenté comme tel** : limite technique réelle, assumée plutôt que cachée.

Aucune affirmation « 100 % sécurisé » dans ce document ni dans la documentation utilisateur (voir contrainte explicite du prompt) : chaque garantie est bornée à ce qu'elle couvre réellement.

---

## A1 — Sauvegarde Android désactivée

**Configuration** : `mobile/app.json`, `android.allowBackup: false`. *Vérifié par lecture du code.*

Cette valeur devient `android:allowBackup="false"` dans le `AndroidManifest.xml` final généré par Expo/Gradle au moment du build — empêche `adb backup`, la sauvegarde automatique Google (si le compte Google du téléphone en a une activée), et le transfert "copier les données de l'ancien téléphone" pour cette application précise.

**Procédure de test (à faire par l'utilisateur, sur un téléphone de test)** :
1. Avec le téléphone branché en USB et le débogage USB activé (voir la procédure déjà suivie cette nuit pour récupérer les journaux de plantage) :
   ```
   adb backup -f test-backup.ab bj.azomedia.aurore.mobile
   ```
2. **Résultat attendu** : la commande échoue immédiatement, ou produit un fichier de sauvegarde vide/invalide (quelques octets, pas de contenu exploitable) — Android refuse de sauvegarder une app qui a explicitement demandé à en être exclue.
3. À comparer avec une autre application quelconque qui n'a pas ce réglage (ex. une app de notes) : celle-là produit un fichier non vide.

*Non testé ce soir faute d'un deuxième appareil de test disponible — à faire avant le pilote.*

---

## A2 — Aucune donnée dans la galerie ni le stockage partagé

**Vérifié par lecture du code** (recherche exhaustive, deux passes) :
- Aucune occurrence de `MediaStore`, `ACTION_MEDIA_SCANNER`, `Environment.getExternalStoragePublic*` dans tout `mobile/` (code JS/TS **et** code natif Kotlin des modules).
- Aucune permission `READ_EXTERNAL_STORAGE`/`WRITE_EXTERNAL_STORAGE` dans `app.json`.
- Tous les fichiers (audio, pages de scan, PDF, clé de chiffrement) sont écrits via `Paths.cache`/`Paths.document` (`expo-file-system`) — ce sont des répertoires **privés à l'application**, inaccessibles par la galerie, par une autre app, ou par l'utilisateur via un gestionnaire de fichiers classique (sans accès root).

Fichiers concernés et leur emplacement privé :
| Contenu | Racine |
|---|---|
| Segments audio chiffrés | `Paths.document/audio-enc/` (`audio/recorder.ts`) |
| Scans chiffrés (PDF) | `Paths.document/scans-enc/` (`scan/scanner.ts`) |
| Photos brutes/pages en cours de scan | `Paths.cache/scan-tmp/` (temporaire, supprimé après assemblage) |
| Journal d'erreurs (exportable volontairement) | `Paths.document/journal-erreurs.ndjson` |

**Procédure de test (à faire par l'utilisateur)** : après un enregistrement et un scan, ouvrir l'application Galerie/Photos du téléphone → aucune nouvelle image ne doit apparaître. *Non re-testé physiquement ce soir (déjà un critère d'acceptation du Prompt 5, jamais contredit depuis par du code qui écrirait ailleurs).*

---

## A3 — Inventaire des dépendances, permissions et trafic réseau

**Dépendances de production** (`mobile/package.json`), toutes auditées une par une :

| Paquet | Rôle | Fait du réseau ? |
|---|---|---|
| `expo`, `expo-status-bar`, `expo-application` | Cœur du framework | Non (pas de télémétrie Expo active — aucun usage de `expo-updates`, qui est la seule brique Expo qui contacterait un serveur) |
| `expo-audio`, `expo-camera`, `expo-crypto`, `expo-file-system`, `expo-local-authentication`, `expo-network`, `expo-screen-capture`, `expo-secure-store`, `expo-sqlite`, `expo-sharing`, `expo-build-properties` | Accès matériel/OS locaux (micro, caméra, biométrie, stockage, partage) | Non — ce sont des accès à l'OS Android, jamais à un serveur |
| `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `react-native-get-random-values` | Cryptographie (chiffrement, ECDH) | Non — calcul local pur |
| `pdf-lib` | Assemblage de PDF | Non — bibliothèque JS pure, aucun appel réseau dans son code |
| `@react-navigation/*`, `react-native-screens`, `react-native-safe-area-context`, `react` , `react-native` | Interface utilisateur | Non |
| `@react-native-community/datetimepicker` | Sélecteur de date natif | Non |

**Tous les appels réseau de l'application, sans exception** (`grep` exhaustif sur `fetch(`, `XMLHttpRequest`, `http://`, `https://` dans tout `mobile/src` et `mobile/modules`) :
```
src/pairing/appareil.ts:111   fetch(`http://${adresse}/api/m/appairage/demander`, ...)
src/pairing/appareil.ts:263   fetch(`http://${adresse}${chemin}`, ...)
```
**Deux lignes au total dans toute l'application**, toutes les deux vers `adresse` — une adresse IP locale du PC du cabinet (venue du QR d'appairage ou saisie à la main dans Réglages), jamais un nom de domaine externe codé en dur. *Vérifié par lecture du code (grep exhaustif, pas d'estimation).*

**Observation du trafic réseau en usage réel** : non réalisée ce soir (demanderait un proxy/une capture de paquets sur le téléphone de test, type mitmproxy, en plus du débogage déjà fait cette nuit) — **marqué explicitement comme non vérifié par capture**, seulement par audit du code source. À faire avant le pilote si une preuve par observation directe est exigée en plus de l'audit de code.

---

## A4 — Captures d'écran bloquées, aperçu masqué, notifications sans contenu

**Captures d'écran et aperçu dans les applications récentes** : `App.tsx:29-31`, `expo-screen-capture` (`preventScreenCaptureAsync`/`allowScreenCaptureAsync`, activé tant que l'app n'est pas verrouillée). *Vérifié par lecture du code.*

Techniquement, cette API active le flag Android `FLAG_SECURE` sur la fenêtre — un comportement garanti par la plateforme Android elle-même (documenté par Google) : **la même protection bloque à la fois les captures d'écran ET l'aperçu dans le sélecteur d'applications récentes** (Android affiche un écran noir à la place). Un seul mécanisme couvre les deux exigences du prompt.

**Notifications sans contenu** : la seule notification permanente de l'app est celle du service de premier plan pendant un enregistrement — `modules/audio-recorder/android/.../EnregistrementService.kt:123-125` : titre "Aurore Mobile", texte "Enregistrement en cours", **jamais** le nom d'un dossier ou d'un client. *Vérifié par lecture du code.*

---

## A5 — Détection de téléphone débridé (root)

**Faisable de façon raisonnablement fiable : oui, en partie** — implémenté dans un nouveau module natif `modules/device-integrity/`, trois indices combinés :
1. `Build.TAGS` contient `"test-keys"` (signe un build AOSP de test, jamais une ROM officielle de fabricant signée).
2. Présence d'un binaire `su` à l'un des emplacements habituels (`/system/bin/su`, `/system/xbin/su`, etc.).
3. Présence d'une application de gestion root connue (Magisk, SuperSU, KingRoot...) — déclarée dans un `<queries>` du manifeste pour rester visible malgré la restriction de visibilité des paquets d'Android 11+.

`AppairageScreen.tsx` appelle cette vérification **avant même de lire le secret du QR** et refuse l'appairage avec un message explicite si un indice est détecté.

**Limite honnête, documentée plutôt que cachée** : cette détection est **contournable par un utilisateur suffisamment déterminé** — Magisk propose depuis plusieurs versions un mode "Hide"/Zygisk qui masque spécifiquement ces trois indices à une application qui les cherche. Aucune détection root sur Android (y compris les solutions commerciales/Play Integrity) n'est une preuve absolue sur un appareil physiquement entre les mains de son propriétaire. Ce que cette détection couvre réellement : le cas très majoritaire d'un root "par défaut", non dissimulé — pas une attaque ciblée et sophistiquée contre Aurore spécifiquement.

*Non testable ce soir sur un vrai téléphone rooté (le Tecno de test ne l'est pas) - code review uniquement, comportement attendu non confirmé sur un appareil réellement débridé.*

---

## B1 — Journal d'erreurs local, exportable

`mobile/src/logs/journal.ts`. Fichier texte en clair (`journal-erreurs.ndjson`, `Paths.document`) — **jamais chiffré**, car son contenu est non confidentiel par construction : chaque ligne est un message déjà réduit à une catégorie générique (ex. `"type=audio Enregistrement trop court..."`, `"Appareil révoqué..."`) **avant** d'être consignée — jamais le texte d'une note, jamais un extrait audio, jamais un nom de dossier/client. Plafonné à 500 lignes (les plus anciennes sont écrasées). Export via le partage natif Android (`expo-sharing`) — l'utilisateur choisit lui-même le canal d'envoi (email, WhatsApp...), rien n'est transmis automatiquement par l'application. Bouton "Exporter le journal" dans Réglages.

*Vérifié par test automatisé* : `mobile/src/logs/journal.test.ts` (6 tests : consignation, plafond, export, échec de partage, vidage, résilience à une erreur d'écriture).

---

## B2 — Mettre à jour l'APK sans perdre les données

**Condition unique et stricte : la même clé de signature.** Android compare la signature du nouvel APK à celle déjà installée — si elles correspondent, l'installation **remplace l'app en place et conserve toutes les données** (base locale, coffre, appairage). Si elles diffèrent, Android refuse l'installation par-dessus (erreur "Application non installée") et il faut désinstaller d'abord, ce qui **efface tout** (déjà rencontré concrètement cette nuit lors du changement de compte EAS, voir le journal de cette session).

**Procédure correcte pour installer une nouvelle version** :
1. Télécharger le nouvel APK depuis le lien EAS fourni.
2. L'ouvrir et appuyer "Installer" — **sans désinstaller l'ancienne version d'abord**.
3. Si Android affiche "Application non installée" : c'est le signe que la clé de signature a changé (ex. changement de compte EAS) — dans ce cas précis seulement, désinstaller puis réinstaller, en sachant que les données locales seront perdues (éléments non encore confirmés, appairage à refaire).

Dans l'usage normal du pilote (même compte EAS, mêmes identifiants de signature gérés par Expo), chaque nouveau build reste installable par-dessus sans perte.

---

## B3 — Signature de production via un secret GitHub

**Choix fait : la signature de production est entièrement gérée par les serveurs Expo (EAS "remote Android credentials")**, jamais par une clé de signature auto-gérée stockée dans un secret GitHub classique. Confirmé dans les journaux de build de cette nuit : *"✔ Using remote Android credentials (Expo server)"*.

Le seul secret nécessaire côté GitHub est **`EXPO_TOKEN`** — déjà créé cette nuit (`gh secret set EXPO_TOKEN`, tapé directement par l'utilisateur dans son terminal, jamais vu ni demandé dans cette conversation). Ce token autorise le workflow à déclencher des builds sur le compte Expo du cabinet ; il ne donne **jamais accès à la clé de signature elle-même**, qui ne quitte jamais l'infrastructure Expo. C'est une garantie plus forte que l'approche "clé de signature dans un secret GitHub" suggérée littéralement par le prompt : ici, ni moi ni le dépôt GitHub ne manipulons jamais la clé privée réelle.

Nouveau profil `mobile/eas.json` → `production` (même mécanisme de signature que `preview`, canal distinct) pour les builds destinés au pilote réel, séparés des builds de test quotidiens.

---

## D — Révocation côté Aurore : coupure immédiate + journal d'audit

**Coupure immédiate (pas de cache)** : `backend/src/middleware/mobileDeviceAuth.ts`, fonction `decoderEnveloppeAppareil` — relit `prisma.mobileDevice.findUnique(...)` à **chaque requête**, aucune mise en cache en mémoire du statut de l'appareil. `exigerAppareilAutorise` (même fichier) bloque (403) dès que `statut !== "autorise"`. Un appareil révoqué perd l'accès à la toute prochaine requête, jamais après un délai.

*Vérifié par test automatisé* (déjà existant, `backend/src/routes/__tests__/mobileSync.test.ts`, test *"refuse (403) un appareil révoqué"*) et par un nouveau test de ce lot (*"convertit un 403 en AppareilRevoqueError"*, côté mobile).

**Journal d'audit** : `backend/src/routes/mobileAppareils.ts:132` — `logMobileAudit(..., "appareil_revoque", "succes", "Révoqué par <userId>", appareil.id)` à chaque révocation ; `:124` pour un refus d'appairage. Consultable depuis "Journal d'audit" (réservé au titulaire).

---

## Résumé — garanti / non garanti

**Garanti** (par construction du code, vérifié par lecture ou test) :
- Aucune donnée mobile dans la galerie ou le stockage partagé.
- Aucun appel réseau de l'application vers autre chose que l'adresse locale d'Aurore.
- Captures d'écran et aperçu "applications récentes" bloqués pendant que l'app est déverrouillée.
- Notification de service jamais porteuse de contenu.
- Révocation d'un appareil : coupure à la requête suivante, tracée dans le journal d'audit.
- Journal d'erreurs exportable sans aucun contenu confidentiel dedans.

**Non garanti, assumé explicitement** :
- La détection de root est contournable par un utilisateur déterminé (Magisk Hide/Zygisk) — protège contre le cas courant, pas contre une attaque ciblée.
- Rien ne protège un fichier qu'un utilisateur choisit **volontairement** de partager hors d'Aurore (capture d'écran impossible dans l'app, mais rien n'empêche de photographier l'écran avec un autre appareil, par exemple).
- Un téléphone déjà infecté par un logiciel malveillant avec les permissions d'accessibilité, ou un appareil physiquement déverrouillé laissé entre d'autres mains, échappe à toute protection applicative.
- La sauvegarde Android désactivée et l'absence de données en galerie reposent sur des procédures de test qui restent **à exécuter par l'utilisateur** sur un appareil physique avant le pilote — documentées ici, pas encore cochées.
