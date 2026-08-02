import { PrismaClient } from "@prisma/client";
import { withEncryptionAtRest } from "../security/prismaEncryption";

// Chiffrement au repos (Lot 2bis) applique de facon transparente : le reste
// du code metier continue d'utiliser `prisma` normalement, en clair. Voir
// README-LOT2BIS.md et security/prismaEncryption.ts.
export const prisma = withEncryptionAtRest(new PrismaClient());
