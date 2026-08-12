-- Permet au titulaire d'un cabinet de retirer, pour un collaborateur precis,
-- l'acces a certains modules (memes cles que cabinets.modules_desactives,
-- gere par la plateforme) - s'applique EN PLUS du reglage plateforme,
-- jamais au-dessus. Migration additive uniquement - aucun impact sur les
-- donnees existantes (tableau vide par defaut = aucune restriction
-- supplementaire).
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260812000000_modules_desactives_collaborateur/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "modules_desactives" TEXT[] DEFAULT ARRAY[]::TEXT[];
