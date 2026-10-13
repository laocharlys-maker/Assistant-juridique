-- CreateTable
CREATE TABLE "stages" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "fiche_personnel_id" TEXT NOT NULL,
    "responsable_id" TEXT NOT NULL,
    "date_debut" TIMESTAMP(3) NOT NULL,
    "date_fin_prevue" TIMESTAMP(3) NOT NULL,
    "statut" TEXT NOT NULL DEFAULT 'en_cours',
    "objet" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_prolongations" (
    "id" TEXT NOT NULL,
    "stage_id" TEXT NOT NULL,
    "ancienne_date_fin" TIMESTAMP(3) NOT NULL,
    "nouvelle_date_fin" TIMESTAMP(3) NOT NULL,
    "motif" TEXT,
    "decide_par_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_prolongations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_rappels_envoyes" (
    "id" TEXT NOT NULL,
    "stage_id" TEXT NOT NULL,
    "palier" TEXT NOT NULL,
    "envoye_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_rappels_envoyes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stages_cabinet_id_idx" ON "stages"("cabinet_id");

-- CreateIndex
CREATE INDEX "stages_fiche_personnel_id_idx" ON "stages"("fiche_personnel_id");

-- CreateIndex
CREATE INDEX "stages_responsable_id_idx" ON "stages"("responsable_id");

-- CreateIndex
CREATE INDEX "stage_prolongations_stage_id_idx" ON "stage_prolongations"("stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "stage_rappels_envoyes_stage_id_palier_key" ON "stage_rappels_envoyes"("stage_id", "palier");

-- AddForeignKey
ALTER TABLE "stages" ADD CONSTRAINT "stages_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stages" ADD CONSTRAINT "stages_fiche_personnel_id_fkey" FOREIGN KEY ("fiche_personnel_id") REFERENCES "fiches_personnel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stages" ADD CONSTRAINT "stages_responsable_id_fkey" FOREIGN KEY ("responsable_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_prolongations" ADD CONSTRAINT "stage_prolongations_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_prolongations" ADD CONSTRAINT "stage_prolongations_decide_par_id_fkey" FOREIGN KEY ("decide_par_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_rappels_envoyes" ADD CONSTRAINT "stage_rappels_envoyes_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
