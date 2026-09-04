-- Plafonds separes par role (avocat / collaborateur), en plus de
-- cabinets.limite_comptes existant (tous roles confondus) - le plus
-- restrictif des deux s'applique a chaque role concerne. Jamais pour
-- titulaire (un seul par cabinet) ni super_admin (compte plateforme, hors
-- donnees d'un cabinet). Migration additive uniquement - deux colonnes
-- nullables, aucun impact sur les donnees existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260904000000_limite_avocats_collaborateurs/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`), et
-- applique automatiquement aux installations existantes au demarrage
-- suivant (voir database/applyPendingMigrations.ts).

-- AlterTable
ALTER TABLE "cabinets" ADD COLUMN "limite_avocats" INTEGER;
ALTER TABLE "cabinets" ADD COLUMN "limite_collaborateurs" INTEGER;
