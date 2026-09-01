-- Ajoute les colonnes necessaires au flux "mot de passe oublie" self-service
-- (routes/auth.ts, POST /api/auth/mot-de-passe-oublie et
-- /api/auth/reinitialiser-mot-de-passe) : un code a 6 chiffres envoye par
-- email, dont seul le hash SHA-256 est stocke (jamais le code en clair),
-- avec une expiration courte. Migration additive uniquement - aucun impact
-- sur les comptes existants (valeurs NULL par defaut = aucune demande en
-- cours).
--
-- Application manuelle (mode externe/reseau) :
--   psql "$DATABASE_URL" -f prisma/migrations/20260901000000_reset_mot_de_passe/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`), et
-- applique aux installations existantes au prochain demarrage (voir
-- src/database/applyPendingMigrations.ts).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "reset_code_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "reset_code_expires_at" TIMESTAMPTZ;
