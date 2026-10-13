-- AlterTable
ALTER TABLE "dossiers" ADD COLUMN "avocat_responsable_id" TEXT;

-- CreateTable
CREATE TABLE "souhaits_conges" (
    "id" TEXT NOT NULL,
    "fiche_personnel_id" TEXT NOT NULL,
    "annee" INTEGER NOT NULL,
    "rang" INTEGER NOT NULL,
    "date_debut" TIMESTAMP(3) NOT NULL,
    "date_fin" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "souhaits_conges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plannings_conges" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "annee" INTEGER NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'brouillon',
    "parametres" JSONB NOT NULL,
    "genere_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "genere_par_id" TEXT NOT NULL,

    CONSTRAINT "plannings_conges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plannings_conges_lignes" (
    "id" TEXT NOT NULL,
    "planning_id" TEXT NOT NULL,
    "fiche_personnel_id" TEXT NOT NULL,
    "date_debut" TIMESTAMP(3) NOT NULL,
    "date_fin" TIMESTAMP(3) NOT NULL,
    "nb_jours_ouvres" DOUBLE PRECISION NOT NULL,
    "origine" TEXT NOT NULL,
    "raison" TEXT,

    CONSTRAINT "plannings_conges_lignes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "souhaits_conges_fiche_personnel_id_annee_rang_key" ON "souhaits_conges"("fiche_personnel_id", "annee", "rang");

-- CreateIndex
CREATE UNIQUE INDEX "plannings_conges_cabinet_id_annee_key" ON "plannings_conges"("cabinet_id", "annee");

-- CreateIndex
CREATE INDEX "plannings_conges_lignes_planning_id_idx" ON "plannings_conges_lignes"("planning_id");

-- AddForeignKey
ALTER TABLE "demandes_absence" ADD CONSTRAINT "demandes_absence_planning_ligne_id_fkey" FOREIGN KEY ("planning_ligne_id") REFERENCES "plannings_conges_lignes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "souhaits_conges" ADD CONSTRAINT "souhaits_conges_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plannings_conges" ADD CONSTRAINT "plannings_conges_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plannings_conges" ADD CONSTRAINT "plannings_conges_genere_par_id_fkey" FOREIGN KEY ("genere_par_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plannings_conges_lignes" ADD CONSTRAINT "plannings_conges_lignes_planning_id_fkey" FOREIGN KEY ("planning_id") REFERENCES "plannings_conges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plannings_conges_lignes" ADD CONSTRAINT "plannings_conges_lignes_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dossiers" ADD CONSTRAINT "dossiers_avocat_responsable_id_fkey" FOREIGN KEY ("avocat_responsable_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
