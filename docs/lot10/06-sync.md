# Prompt 6 — File d'envoi hors ligne et synchronisation : ce qui est garanti

## Pourquoi ce document existe

Le prompt demande explicitement : *"Dis honnêtement ce qui est garanti et
ce qui ne l'est pas"* pour la synchronisation en arrière-plan. Le spike du
Prompt 4 (`docs/lot10/04-spike-audio.md`) a déjà montré, sur un test réel
(Tecno Spark 20, HiOS), qu'un **service de premier plan actif** — le
mécanisme le plus protégé qu'Android propose — peut quand même être tué par
le gestionnaire de batterie du constructeur. La synchronisation réseau n'a
*aucun* mécanisme équivalent à sa disposition : il n'y a pas de notification
permanente à afficher pour justifier qu'elle tourne en continu.

## Ce qui est garanti

- **Au lancement de l'application** : `App.tsx` ne fait rien de
  particulier à ce sujet, mais l'écran d'accueil (`AccueilScreen`) lance
  une vérification de connexion dès qu'il reçoit le focus.
- **Tant que l'application reste ouverte** : un intervalle de 15 secondes
  (`AccueilScreen`) revérifie la connexion ; l'écran "Mes éléments"
  retente l'envoi de tout élément éligible (voir `elementsARetenter`,
  `sync/elements.ts`) et vérifie les confirmations chaque fois qu'il reçoit
  le focus.
- **Délais croissants entre deux tentatives d'un même élément**
  (`sync/backoff.ts`) : 5 s, 15 s, 60 s, 5 min, 15 min (palier final) — pas
  de boucle serrée qui viderait la batterie en cas d'échec persistant.
- **Plusieurs adresses connues, la dernière qui a fonctionné en premier**
  (`pairing/appareil.ts`, `adressesTriees`) : survit à un changement d'IP
  du PC sur le réseau local sans intervention manuelle, dans la limite des
  adresses déjà vues (jamais un balayage réseau plus large).
- **Reprise exacte après coupure** (`nombreChunksEnvoyes`, persisté après
  chaque morceau) : un envoi interrompu repart du morceau suivant, jamais
  depuis zéro - vérifié dans `sync/elements.test.ts` et
  `backend/src/routes/__tests__/mobileSync.test.ts`.
- **Aucune perte** : un élément ne quitte "Mes éléments" qu'après un
  statut "confirmé" explicite reçu d'Aurore (voir `MesElementsScreen.tsx`,
  `peutSupprimer`) - une coupure, un redémarrage du téléphone ou une
  fermeture de l'application ne fait jamais disparaître un élément en
  attente (stocké dans `expo-sqlite`, persistant par construction).

## Ce qui N'est PAS garanti

- **Aucune tâche de fond véritable n'est enregistrée auprès d'Android**
  (pas de `expo-background-task`/`BackgroundFetch`, pas de second service
  de premier plan dédié à la synchronisation). Tant que l'application est
  fermée (pas seulement en arrière-plan récent, mais réellement arrêtée par
  l'utilisateur ou par le système), **rien ne se synchronise** - il faut
  rouvrir l'application.
- Ce choix n'est pas un oubli : ajouter un service de premier plan
  supplémentaire *juste pour la synchronisation* ajouterait une deuxième
  notification permanente intrusive, pour un gain incertain - le spike du
  Prompt 4 a déjà montré qu'un service de premier plan peut être tué par
  certains constructeurs (HiOS confirmé) malgré tout. Mieux vaut le dire
  clairement que prétendre une fiabilité qu'on ne peut pas tenir.
- **Aucun écouteur de changement réseau en temps réel** (pas de
  `@react-native-community/netinfo`) : le retour sur le Wi-Fi n'est détecté
  qu'au prochain passage de l'intervalle de 15 secondes ou à la prochaine
  ouverture d'un écran concerné - jamais instantané, mais jamais plus de
  15 secondes de retard non plus pendant que l'app est ouverte.
- **`GET /m/ping`** : le prompt mentionne un GET, mais le protocole retenu
  depuis le Prompt 1 chiffre systématiquement le corps de chaque requête
  (voir `docs/lot10/01-protocole.md` section 4) - un GET ne peut pas
  transporter ce corps chiffré de façon fiable. Toutes les routes
  `/api/m/*`, ping compris, restent en POST - décision déjà prise avant ce
  prompt, non remise en cause ici.

## Cas limites (objectif E)

| Cas | Comportement |
|---|---|
| Appareil révoqué | `AppareilRevoqueError` dédiée (statut HTTP 403, seule signification possible dans ce protocole) → élément marqué "en erreur" de façon **permanente** (jamais retenté), bannière claire sur l'accueil, élément conservé sur le téléphone. |
| Horloge décalée | Déjà rejeté (401) côté serveur depuis le Prompt 4 avec un message explicite et un audit log dédié - traité comme une erreur transitoire ordinaire côté téléphone (délai croissant, nouvelle tentative). |
| "Jeton expiré" | Ce protocole n'a pas de jeton porteur (voir `01-protocole.md`) - rien à expirer. La requête rejouée (compteur) est l'équivalent le plus proche, déjà gérée (409, transitoire, se résorbe au prochain compteur). |
| Disque presque plein | Vérifié **avant** de démarrer un enregistrement ou un scan (`storage/espace.ts`, seuil 100 Mo) - message clair plutôt qu'une erreur native cryptique en plein milieu de l'écriture. |
| PC éteint | Indistinct d'une coupure réseau ordinaire côté téléphone - `PcIntrouvableError`, message "Aurore introuvable sur ce réseau", nouvelle tentative avec délai croissant. |
