-- Rattrapage au demarrage pour la veille juridique et le recapitulatif du
-- role de la semaine (voir utils/creneauHebdomadaire.ts) : ces deux envois
-- automatiques dependent d'un cron interne a l'application (voir index.ts),
-- qui ne se declenche que si Aurore est ouvert au moment precis (lundi 7h /
-- vendredi 8h, heure du Benin) - sans rattrapage, une app fermee a cette
-- heure perd l'envoi pour toute la semaine, sans aucun moyen de le
-- recuperer. Ces deux colonnes memorisent le dernier creneau deja traite
-- par cabinet, pour rattraper au prochain demarrage tout en evitant un envoi
-- en double si l'app redemarre plusieurs fois la meme semaine. Migration
-- additive uniquement - NULL par defaut = jamais encore execute, aucun
-- impact sur les cabinets existants.
--
-- Application manuelle (mode externe/reseau) :
--   psql "$DATABASE_URL" -f prisma/migrations/20260902000000_rattrapage_cron_hebdomadaire/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`), et
-- applique aux installations existantes au prochain demarrage (voir
-- src/database/applyPendingMigrations.ts).

-- AlterTable
ALTER TABLE "cabinets" ADD COLUMN "veille_derniere_execution" TIMESTAMPTZ;
ALTER TABLE "cabinets" ADD COLUMN "role_semaine_derniere_execution" TIMESTAMPTZ;
