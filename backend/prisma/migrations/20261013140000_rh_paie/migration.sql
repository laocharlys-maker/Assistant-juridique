-- CreateTable
CREATE TABLE "elements_salaire" (
    "id" TEXT NOT NULL,
    "fiche_personnel_id" TEXT NOT NULL,
    "sens" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "mode_calcul" TEXT NOT NULL,
    "valeur" INTEGER NOT NULL,
    "base_calcul" TEXT,
    "date_debut" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "date_fin" TIMESTAMP(3),
    "actif" BOOLEAN NOT NULL DEFAULT true,
    "est_salaire_base" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "elements_salaire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "periodes_paie" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "mois" TEXT NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'ouverte',

    CONSTRAINT "periodes_paie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ajustements_mensuels" (
    "id" TEXT NOT NULL,
    "periode_paie_id" TEXT NOT NULL,
    "fiche_personnel_id" TEXT NOT NULL,
    "sens" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "montant" INTEGER NOT NULL,

    CONSTRAINT "ajustements_mensuels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiches_paie" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "periode_paie_id" TEXT NOT NULL,
    "fiche_personnel_id" TEXT NOT NULL,
    "numero" TEXT,
    "statut" TEXT NOT NULL DEFAULT 'brouillon',
    "version" INTEGER NOT NULL DEFAULT 1,
    "brut" INTEGER NOT NULL DEFAULT 0,
    "total_retenues" INTEGER NOT NULL DEFAULT 0,
    "net" INTEGER NOT NULL DEFAULT 0,
    "chemin_pdf" TEXT,
    "valide_le" TIMESTAMP(3),
    "valide_par_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiches_paie_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiches_paie_lignes" (
    "id" TEXT NOT NULL,
    "fiche_paie_id" TEXT NOT NULL,
    "ordre" INTEGER NOT NULL,
    "sens" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "base" INTEGER,
    "taux" INTEGER,
    "montant" INTEGER NOT NULL,

    CONSTRAINT "fiches_paie_lignes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "elements_salaire_fiche_personnel_id_idx" ON "elements_salaire"("fiche_personnel_id");

-- CreateIndex
CREATE UNIQUE INDEX "periodes_paie_cabinet_id_mois_key" ON "periodes_paie"("cabinet_id", "mois");

-- CreateIndex
CREATE INDEX "ajustements_mensuels_periode_paie_id_idx" ON "ajustements_mensuels"("periode_paie_id");

-- CreateIndex
CREATE INDEX "ajustements_mensuels_fiche_personnel_id_idx" ON "ajustements_mensuels"("fiche_personnel_id");

-- CreateIndex
CREATE INDEX "fiches_paie_cabinet_id_idx" ON "fiches_paie"("cabinet_id");

-- CreateIndex
CREATE INDEX "fiches_paie_fiche_personnel_id_idx" ON "fiches_paie"("fiche_personnel_id");

-- CreateIndex
CREATE UNIQUE INDEX "fiches_paie_periode_paie_id_fiche_personnel_id_version_key" ON "fiches_paie"("periode_paie_id", "fiche_personnel_id", "version");

-- CreateIndex
CREATE INDEX "fiches_paie_lignes_fiche_paie_id_idx" ON "fiches_paie_lignes"("fiche_paie_id");

-- AddForeignKey
ALTER TABLE "elements_salaire" ADD CONSTRAINT "elements_salaire_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "periodes_paie" ADD CONSTRAINT "periodes_paie_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ajustements_mensuels" ADD CONSTRAINT "ajustements_mensuels_periode_paie_id_fkey" FOREIGN KEY ("periode_paie_id") REFERENCES "periodes_paie"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ajustements_mensuels" ADD CONSTRAINT "ajustements_mensuels_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiches_paie" ADD CONSTRAINT "fiches_paie_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiches_paie" ADD CONSTRAINT "fiches_paie_periode_paie_id_fkey" FOREIGN KEY ("periode_paie_id") REFERENCES "periodes_paie"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiches_paie" ADD CONSTRAINT "fiches_paie_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiches_paie" ADD CONSTRAINT "fiches_paie_valide_par_id_fkey" FOREIGN KEY ("valide_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiches_paie_lignes" ADD CONSTRAINT "fiches_paie_lignes_fiche_paie_id_fkey" FOREIGN KEY ("fiche_paie_id") REFERENCES "fiches_paie"("id") ON DELETE CASCADE ON UPDATE CASCADE;
