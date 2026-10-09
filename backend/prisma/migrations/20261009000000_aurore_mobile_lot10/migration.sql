-- CreateEnum
CREATE TYPE "StatutMobileDevice" AS ENUM ('en_attente', 'autorise', 'revoque');

-- CreateEnum
CREATE TYPE "TypeMobileItem" AS ENUM ('audio', 'scan', 'note');

-- CreateEnum
CREATE TYPE "TypeScanMobile" AS ENUM ('piece', 'decision', 'courrier', 'convocation', 'autre');

-- CreateEnum
CREATE TYPE "StatutMobileItem" AS ENUM ('recu', 'a_traiter', 'traite');

-- CreateEnum
CREATE TYPE "TypeMobileMarker" AS ENUM ('prochaine_audience', 'decision', 'a_faire', 'point_important');

-- AlterTable
ALTER TABLE "cabinets" ADD COLUMN     "mobile_server_cle_privee" TEXT,
ADD COLUMN     "mobile_server_cle_publique" TEXT,
ADD COLUMN     "mobile_sync_actif" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mobile_sync_interface" TEXT,
ADD COLUMN     "mobile_sync_port" INTEGER NOT NULL DEFAULT 3100;

-- CreateTable
CREATE TABLE "mobile_devices" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "nom_declare" TEXT NOT NULL,
    "cle_publique" TEXT NOT NULL,
    "statut" "StatutMobileDevice" NOT NULL DEFAULT 'en_attente',
    "dernier_compteur" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autorise_at" TIMESTAMP(3),
    "derniere_connexion_at" TIMESTAMP(3),
    "revoque_at" TIMESTAMP(3),

    CONSTRAINT "mobile_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_pairing_secrets" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "expire_at" TIMESTAMP(3) NOT NULL,
    "utilise" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mobile_pairing_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_items" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "type" "TypeMobileItem" NOT NULL,
    "dossier_id" TEXT,
    "type_scan" "TypeScanMobile",
    "statut" "StatutMobileItem" NOT NULL DEFAULT 'recu',
    "chemin_fichier" TEXT,
    "taille_octets" INTEGER,
    "sha256" TEXT,
    "duree_secondes" INTEGER,
    "cree_le_sur_appareil" TIMESTAMP(3),
    "recu_le" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prochaine_audience" TIMESTAMP(3),
    "note_texte" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mobile_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_markers" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "type" "TypeMobileMarker" NOT NULL,
    "position_ms" INTEGER NOT NULL,
    "date_audience" TIMESTAMP(3),

    CONSTRAINT "mobile_markers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mobile_audit_logs" (
    "id" TEXT NOT NULL,
    "cabinet_id" TEXT NOT NULL,
    "device_id" TEXT,
    "etape" TEXT NOT NULL,
    "statut" "StatutExecution" NOT NULL,
    "detail" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mobile_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mobile_devices_cabinet_id_idx" ON "mobile_devices"("cabinet_id");

-- CreateIndex
CREATE INDEX "mobile_devices_user_id_idx" ON "mobile_devices"("user_id");

-- CreateIndex
CREATE INDEX "mobile_pairing_secrets_cabinet_id_idx" ON "mobile_pairing_secrets"("cabinet_id");

-- CreateIndex
CREATE INDEX "mobile_items_cabinet_id_idx" ON "mobile_items"("cabinet_id");

-- CreateIndex
CREATE INDEX "mobile_items_dossier_id_idx" ON "mobile_items"("dossier_id");

-- CreateIndex
CREATE UNIQUE INDEX "mobile_items_device_id_client_id_key" ON "mobile_items"("device_id", "client_id");

-- CreateIndex
CREATE INDEX "mobile_markers_item_id_idx" ON "mobile_markers"("item_id");

-- CreateIndex
CREATE INDEX "mobile_audit_logs_cabinet_id_idx" ON "mobile_audit_logs"("cabinet_id");

-- CreateIndex
CREATE INDEX "mobile_audit_logs_device_id_idx" ON "mobile_audit_logs"("device_id");

-- AddForeignKey
ALTER TABLE "mobile_devices" ADD CONSTRAINT "mobile_devices_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_devices" ADD CONSTRAINT "mobile_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_pairing_secrets" ADD CONSTRAINT "mobile_pairing_secrets_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_pairing_secrets" ADD CONSTRAINT "mobile_pairing_secrets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_items" ADD CONSTRAINT "mobile_items_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_items" ADD CONSTRAINT "mobile_items_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "mobile_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_items" ADD CONSTRAINT "mobile_items_dossier_id_fkey" FOREIGN KEY ("dossier_id") REFERENCES "dossiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_markers" ADD CONSTRAINT "mobile_markers_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "mobile_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_audit_logs" ADD CONSTRAINT "mobile_audit_logs_cabinet_id_fkey" FOREIGN KEY ("cabinet_id") REFERENCES "cabinets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mobile_audit_logs" ADD CONSTRAINT "mobile_audit_logs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "mobile_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

