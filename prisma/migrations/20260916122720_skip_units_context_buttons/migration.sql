-- AlterEnum
ALTER TYPE "DeliveryStatus" ADD VALUE 'replaced';

-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "cropMarginSteps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extraAfter" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extraBefore" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "lines" ADD COLUMN     "skipped" BOOLEAN NOT NULL DEFAULT false;
