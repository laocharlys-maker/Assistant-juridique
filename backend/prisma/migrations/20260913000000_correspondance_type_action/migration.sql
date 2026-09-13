-- Lot "Répondre au courrier" (2026-09-13) - nouveau type de document
-- "correspondance" (courrier simple, souvent une réponse à un courrier reçu),
-- le plus simple des types "rédiger" existants. Migration additive :
-- ajoute une valeur à un enum existant, aucun impact sur les données
-- existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260913000000_correspondance_type_action/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`), et
-- applique automatiquement aux installations existantes au demarrage
-- suivant (voir database/applyPendingMigrations.ts).

-- AlterEnum
ALTER TYPE "TypeAction" ADD VALUE 'correspondance';
