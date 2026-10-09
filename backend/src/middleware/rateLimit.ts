import rateLimit from "express-rate-limit";

// Connexion : protection contre le brute-force du mot de passe. Limite par
// IP, pas par compte, pour ne pas bloquer un utilisateur legitime a cause
// d'un tiers malveillant visant son email.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives de connexion. Réessaie dans quelques minutes." },
});

// Actions IA (redaction, recherche, resume, traduction...) : protection
// contre l'abus qui ferait exploser la facture LLM/Tavily.
export const aiActionsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de générations en peu de temps. Réessaie dans quelques minutes." },
});

// Filet de securite general sur l'ensemble de l'API, plus permissif.
export const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes. Réessaie dans quelques minutes." },
});

// Lot 10 (Aurore Mobile) - instance Express ISOLEE du serveur mobile
// (voir mobileServer.ts) : n'herite pas de globalApiLimiter ci-dessus
// (applique seulement a l'app principale, app.ts). Un peu plus permissif
// que la demande d'appairage ci-dessous (trafic legitime regulier : ping,
// envoi d'elements par morceaux).
export const mobileApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes." },
});

// Demande d'appairage (POST /api/m/appairage/demander) : SEULE route non
// authentifiee de tout le serveur mobile - defense en profondeur contre un
// brute-force du secret (32 octets, deja infaisable en 5 minutes, mais
// aucune raison de laisser un volume anormal passer sans limite). Un
// cabinet appaire rarement plus de quelques telephones.
export const mobilePairingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives d'appairage. Réessaie dans quelques minutes." },
});
