-- Demande explicite de l'utilisateur (2026-10-06) : la coquille a onglets
-- ne doit jamais etre active par defaut - seul celui qui le souhaite va
-- cocher l'option dans Mon profil > Affichage. La precedente migration
-- (20261006000000) avait mis onglets_actifs a true par defaut - corrige
-- ici avant toute vraie mise en production (encore aucune release
-- publique publiee a ce stade).
--
-- Application manuelle (mode externe/reseau) :
--   psql "$DATABASE_URL" -f prisma/migrations/20261006000001_onglets_actifs_defaut_false/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql.

ALTER TABLE "users" ALTER COLUMN "onglets_actifs" SET DEFAULT false;

-- Remet tous les comptes existants a false - personne n'a encore eu
-- l'occasion d'activer explicitement cette option (jamais publiee).
UPDATE "users" SET "onglets_actifs" = false;
