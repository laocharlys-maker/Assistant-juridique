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
