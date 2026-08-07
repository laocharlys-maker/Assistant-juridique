-- Lot 10 : remarques de revision (avocat/titulaire -> collaborateur) sur un
-- document en attente de validation. Migration additive uniquement -
-- nouvelle valeur d'enum + nouvelle table, aucun impact sur les donnees
-- existantes.
--
-- Application manuelle (mode externe/reseau), meme remarque que les
-- migrations des Lots 2bis/3/5 (ce projet n'utilise pas l'historique
-- "prisma migrate deploy") :
--   psql "$DATABASE_URL" -f prisma/migrations/20260807000000_commentaires_revision/migration.sql
-- Mode portable : deja inclus automatiquement dans prisma/portable-init.sql
-- (regenere depuis schema.prisma via `npm run prisma:portable-sql`).

ALTER TYPE "StatutAction" ADD VALUE IF NOT EXISTS 'revision_demandee';

-- CreateTable
CREATE TABLE "commentaires_revision" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "auteur_id" TEXT NOT NULL,
    "contenu" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'ouvert',
    "date_creation" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_resolution" TIMESTAMP(3),
    "resolu_par_id" TEXT,

    CONSTRAINT "commentaires_revision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "commentaires_revision_action_id_idx" ON "commentaires_revision"("action_id");

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_auteur_id_fkey" FOREIGN KEY ("auteur_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commentaires_revision" ADD CONSTRAINT "commentaires_revision_resolu_par_id_fkey" FOREIGN KEY ("resolu_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
