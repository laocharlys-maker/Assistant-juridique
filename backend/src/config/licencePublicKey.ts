/**
 * Cle publique Ed25519 utilisee pour verifier la signature des fichiers de
 * licence (Lot 3). Cle de PRODUCTION (Lot 4, service Cloudflare Workers
 * aurore-licence-service) - la paire privee correspondante est stockee
 * exclusivement en secret Cloudflare (PRIVATE_KEY_PEM), jamais dans ce
 * depot. L'ancien placeholder de test reste disponible separement dans
 * backend/test-keys/licence-test-public.pem (voir README-LOT3.md) pour le
 * developpement local.
 *
 * Cette cle est PUBLIQUE par nature (elle sert uniquement a verifier,
 * jamais a signer) : l'embarquer en dur dans le code source de
 * l'application n'est pas un probleme de securite, contrairement a une cle
 * privee.
 */
export const LICENCE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5mMXx03SGFcjFSdJp5+TsjkFZBHTajq7fC5qCY0aHA8=
-----END PUBLIC KEY-----
`;

/** true tant que la cle ci-dessus est le placeholder de test - sert a
 * afficher un avertissement au demarrage (voir index.ts) plutot que de
 * laisser tourner silencieusement en production avec la mauvaise cle. */
export const LICENCE_PUBLIC_KEY_IS_TEST_PLACEHOLDER = false;
