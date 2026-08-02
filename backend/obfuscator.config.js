// Lot 7 : configuration javascript-obfuscator pour le bundle SEA (voir
// scripts/build-sea.js). Calibree pour une protection reelle sans casser
// les performances de demarrage ni la lisibilite d'une pile d'appel en cas
// de crash - voir README-LOT7.md "Limites de la protection anti-copie"
// pour ce que cette etape protege reellement (dissuasion de la lecture
// occasionnelle, pas une barriere infranchissable).
//
// Options DELIBEREMENT desactivees (et pourquoi) :
// - selfDefending : le code obfusque detecte le formatage/debogage de
//   lui-meme et casse son propre fonctionnement si modifie - notoirement
//   fragile (faux positifs frequents selon l'environnement d'execution),
//   et va a l'encontre de l'objectif explicite de pouvoir deboguer un
//   crash en production a partir de la source map interne.
// - debugProtection : pensee pour genrer les DevTools d'un navigateur
//   (boucles anti-debogueur, etc.) - sans objet pour un backend Node, et
//   memes risques de fragilite que selfDefending.
// - deadCodeInjection : multiplie fortement la taille du bundle (code mort
//   ajoute un peu partout) pour un gain de protection marginal - exclu
//   explicitement par la contrainte du prompt ("options les plus
//   agressives qui peuvent multiplier la taille du bundle").
// - disableConsoleOutput : casserait les logs de diagnostic normaux de
//   l'application (demarrage, erreurs...), qui doivent continuer a
//   fonctionner normalement en production.
module.exports = {
  compact: true,
  target: "node",

  // Renomme variables/fonctions en identifiants hexadecimaux courts - c'est
  // la protection la plus determinante pour la lisibilite du code (voir
  // test qualitatif README-LOT7.md) et n'a quasiment aucun cout de
  // performance (juste des noms differents, pas de logique ajoutee).
  identifierNamesGenerator: "hexadecimal",
  // true (et non le "false" plus prudent souvent recommande par la doc
  // officielle) : verifie empiriquement necessaire ici, car ce projet
  // obfusque CHAQUE fichier de dist/ INDIVIDUELLEMENT, avant le bundling
  // esbuild (voir README-LOT7.md). Sans cela, javascript-obfuscator traite
  // toute declaration de premier niveau d'un fichier (ex: `const
  // licenceManager_1 = require(...)`, genere par l'interop CommonJS de
  // TypeScript) comme une "variable globale" et refuse de la renommer -
  // constate concretement en cherchant "licenceManager"/"empreinteMachine"/
  // "motDePasse" en clair dans le bundle final malgre l'obfuscation. Chaque
  // fichier etant de toute facon un module CommonJS isole a l'execution
  // (les references inter-fichiers passent uniquement par
  // require()/module.exports, jamais par un identifiant partage), renommer
  // ses declarations de premier niveau est sans risque.
  renameGlobals: true,

  // controlFlowFlattening DESACTIVE : teste empiriquement sur le bundle
  // complet d'Aurore (~17 Mo une fois toutes les dependances incluses -
  // SDK Anthropic/Gemini, docx, mammoth...) - meme au seuil "modere" 0.3,
  // ce transform fait sortir javascript-obfuscator en "JavaScript heap out
  // of memory" apres plus de 3 minutes (voir README-LOT7.md "Obfuscation -
  // ajustements empiriques"). C'est exactement le risque que la contrainte
  // du prompt demandait d'eviter ("options les plus agressives qui peuvent
  // multiplier la taille du bundle") : sur un bundle de cette taille,
  // controlFlowFlattening n'est pas "agressif vs modere", il est
  // simplement inutilisable. stringArray + le renommage d'identifiants
  // (couts lineaires, pas exponentiels) restent actifs et suffisent pour
  // la protection visee par ce lot.
  controlFlowFlattening: false,

  // Deplace les chaines litterales dans un tableau dedie, encode en
  // base64 - protection significative (cle API en dur, chemins internes,
  // messages d'erreur...) sans le cout d'un chiffrement RC4 par chaine.
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ["base64"],
  stringArrayRotate: true,
  stringArrayShuffle: true,

  // CRITIQUE pour le packaging Node SEA (voir README-LOT7.md "Bug decouvert
  // : import() dynamique casse par stringArray") : sans ceci, stringArray
  // deplace aussi les chaines litterales utilisees comme specificateur d'un
  // import()/require() relatif ("./config/env", "../lib/prisma"...) dans le
  // tableau de chaines, les remplacant par un appel de fonction - esbuild
  // ne peut alors plus resoudre l'import statiquement au moment du bundling
  // (l'obfuscation tourne AVANT le bundling, voir scripts/build-sea.js), et
  // le module correspondant se retrouve exclu du bundle. A l'execution,
  // Node tente de le charger via son mecanisme SEA "embedderRequire" (reserve
  // aux modules natifs) et echoue avec ERR_UNKNOWN_BUILTIN_MODULE - constate
  // empiriquement en testant le binaire complet apres l'ajout de
  // l'obfuscation, pas seulement l'obfuscation isolee (exactement la
  // verification demandee par le prompt). reservedStrings protege ces
  // chaines de tout transform (stringArray comme splitStrings), tout en
  // laissant l'obfuscation s'appliquer normalement partout ailleurs.
  reservedStrings: ["^\\.\\.?/"],

  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  numbersToExpressions: false,
  splitStrings: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,

  // Source map generee a part (jamais embarquee dans le bundle final ni
  // livree au client) - copiee dans dist-sea-debug/ par build-sea.js, pour
  // pouvoir retrouver l'emplacement d'origine d'un crash en production
  // sans deviner du code renomme. Voir README-LOT7.md.
  sourceMap: true,
  sourceMapMode: "separate",
};
