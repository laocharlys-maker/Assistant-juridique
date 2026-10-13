-- AlterTable
ALTER TABLE "cabinets" ADD COLUMN "rh_samedi_ouvre" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "types_absence" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "libelle" TEXT NOT NULL,
    "decompte_solde" BOOLEAN NOT NULL DEFAULT true,
    "remunere" BOOLEAN NOT NULL DEFAULT true,
    "justificatif_requis" BOOLEAN NOT NULL DEFAULT false,
    "actif" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "types_absence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jours_feries" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "libelle" TEXT NOT NULL,
    "recurrent_chaque_annee" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "jours_feries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "soldes_conges" (
    "id" TEXT NOT NULL,
    "fiche_personnel_id" TEXT NOT NULL,
    "annee" INTEGER NOT NULL,
    "droit_jours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "report_jours" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "soldes_conges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demandes_absence" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "fiche_personnel_id" TEXT NOT NULL,
    "type_absence_id" TEXT NOT NULL,
    "date_debut" TIMESTAMP(3) NOT NULL,
    "date_fin" TIMESTAMP(3) NOT NULL,
    "demi_journee_debut" BOOLEAN NOT NULL DEFAULT false,
    "demi_journee_fin" BOOLEAN NOT NULL DEFAULT false,
    "nb_jours_ouvres" DOUBLE PRECISION NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_attente',
    "planning_ligne_id" TEXT,
    "decide_par_id" TEXT,
    "date_decision" TIMESTAMP(3),
    "commentaire_decision" TEXT,
    "motif" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demandes_absence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "types_absence_cabinet_id_idx" ON "types_absence"("cabinet_id");

-- CreateIndex
CREATE INDEX "jours_feries_cabinet_id_idx" ON "jours_feries"("cabinet_id");

-- CreateIndex
CREATE UNIQUE INDEX "soldes_conges_fiche_personnel_id_annee_key" ON "soldes_conges"("fiche_personnel_id", "annee");

-- CreateIndex
CREATE INDEX "demandes_absence_cabinet_id_idx" ON "demandes_absence"("cabinet_id");

-- CreateIndex
CREATE INDEX "demandes_absence_fiche_personnel_id_idx" ON "demandes_absence"("fiche_personnel_id");

-- CreateIndex
CREATE INDEX "demandes_absence_statut_idx" ON "demandes_absence"("statut");

-- AddForeignKey
ALTER TABLE "types_absence" ADD CONSTRAINT "types_absence_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jours_feries" ADD CONSTRAINT "jours_feries_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "soldes_conges" ADD CONSTRAINT "soldes_conges_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandes_absence" ADD CONSTRAINT "demandes_absence_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandes_absence" ADD CONSTRAINT "demandes_absence_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandes_absence" ADD CONSTRAINT "demandes_absence_type_absence_id_fkey" FOREIGN KEY ("type_absence_id") REFERENCES "types_absence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demandes_absence" ADD CONSTRAINT "demandes_absence_decide_par_id_fkey" FOREIGN KEY ("decide_par_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
