/**
 * Cle publique Ed25519 utilisee pour verifier la signature des fichiers de
 * licence (Lot 3). PLACEHOLDER DE DEVELOPPEMENT : il s'agit de la cle
 * publique de test versionnee dans backend/test-keys/licence-test-public.pem
 * (voir README-LOT3.md) - PAS la cle de production.
 *
 * A REMPLACER par la vraie cle publique au Lot 4 (service Cloudflare
 * Workers de generation des licences), une fois celui-ci disponible. Cette
 * cle est PUBLIQUE par nature (elle sert uniquement a verifier, jamais a
 * signer) : l'embarquer en dur dans le code source de l'application n'est
 * pas un probleme de securite, contrairement a une cle privee.
 */
export const LICENCE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAkfW7THJVMk+WOcusCfQ2ZX6Fb0oo7wmJOQXehQIMlm8=
-----END PUBLIC KEY-----
`;

/** true tant que la cle ci-dessus est le placeholder de test - sert a
 * afficher un avertissement au demarrage (voir index.ts) plutot que de
 * laisser tourner silencieusement en production avec la mauvaise cle. */
export const LICENCE_PUBLIC_KEY_IS_TEST_PLACEHOLDER = true;
