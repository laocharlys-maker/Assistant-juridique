-- Notification in-app de la veille juridique (EN PLUS de l'email existant,
-- jamais a sa place - voir routes/veilleJuridiqueNotification.ts et
-- public/js/layout.js). Cette colonne memorise, PAR UTILISATEUR, le dernier
-- digest (Action.createdAt) deja vu via la pop-up in-app - evite de la
-- rafficher a chaque page tant qu'un nouveau digest n'est pas disponible.
-- Migration additive uniquement - NULL par defaut = jamais encore vu,
-- aucun impact sur les comptes existants ni sur l'envoi email (inchange).
--
-- Application manuelle (mode externe/reseau) :
--   psql "$DATABASE_URL" -f prisma/migrations/20260902010000_veille_derniere_vue/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`), et
-- applique aux installations existantes au prochain demarrage (voir
-- src/database/applyPendingMigrations.ts).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "veille_derniere_vue" TIMESTAMPTZ;
