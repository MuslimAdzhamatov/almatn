-- CreateEnum
CREATE TYPE "PortionKind" AS ENUM ('learning', 'known');

-- AlterTable
ALTER TABLE "plans" ADD COLUMN     "knownFrom" INTEGER,
ADD COLUMN     "knownTo" INTEGER;

-- AlterTable
ALTER TABLE "portions" ADD COLUMN     "kind" "PortionKind" NOT NULL DEFAULT 'learning';
