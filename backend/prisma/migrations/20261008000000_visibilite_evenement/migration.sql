-- CreateEnum
CREATE TYPE "VisibiliteEvenement" AS ENUM ('prive', 'equipe', 'cabinet');

-- AlterTable
ALTER TABLE "evenements" ADD COLUMN     "visibilite" "VisibiliteEvenement" NOT NULL DEFAULT 'equipe';

