-- CreateTable
CREATE TABLE "journal_connexions" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "connecte_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "derniere_activite_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deconnecte_le" TIMESTAMP(3),
    "adresse_ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "journal_connexions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_activites" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "user_id" TEXT,
    "type" TEXT NOT NULL,
    "cible" TEXT,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_activites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "journal_connexions_cabinet_id_connecte_le_idx" ON "journal_connexions"("cabinet_id", "connecte_le");

-- CreateIndex
CREATE INDEX "journal_connexions_user_id_idx" ON "journal_connexions"("user_id");

-- CreateIndex
CREATE INDEX "journal_activites_cabinet_id_created_at_idx" ON "journal_activites"("cabinet_id", "created_at");

-- CreateIndex
CREATE INDEX "journal_activites_user_id_idx" ON "journal_activites"("user_id");

-- AddForeignKey
ALTER TABLE "journal_connexions" ADD CONSTRAINT "journal_connexions_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_connexions" ADD CONSTRAINT "journal_connexions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_activites" ADD CONSTRAINT "journal_activites_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_activites" ADD CONSTRAINT "journal_activites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
