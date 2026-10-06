-- Coquille a onglets (2026-10-06) - preference individuelle pour activer/
-- desactiver l'ouverture des ecrans en onglets persistants, et
-- autosauvegarde serveur des formulaires longs de "Nouvelle action" (prive a
-- chaque compte). Migration additive : aucun impact sur les donnees
-- existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations precedentes (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20261006000000_onglets_et_brouillons_formulaire/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`), et
-- applique automatiquement aux installations existantes au demarrage
-- suivant (voir database/applyPendingMigrations.ts).

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "onglets_actifs" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "brouillons_formulaire" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type_action" TEXT NOT NULL,
    "donnees" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brouillons_formulaire_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brouillons_formulaire_user_id_type_action_key" ON "brouillons_formulaire"("user_id", "type_action");

-- AddForeignKey
ALTER TABLE "brouillons_formulaire" ADD CONSTRAINT "brouillons_formulaire_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
