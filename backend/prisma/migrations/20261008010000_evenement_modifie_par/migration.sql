-- AlterTable
ALTER TABLE "evenements" ADD COLUMN     "updated_by_id" TEXT;

-- AddForeignKey
ALTER TABLE "evenements" ADD CONSTRAINT "evenements_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

