-- Этап 3b, шаг 1: единица заучивания получает фрагменты (абзац на нескольких страницах,
-- заголовок раздела перед строкой), тексты из картинок и отложенные загрузки.

-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('pdf', 'images');

-- CreateEnum
CREATE TYPE "FragmentKind" AS ENUM ('text', 'heading');

-- AlterEnum
ALTER TYPE "ParseStrategy" ADD VALUE 'paragraphs';

-- AlterEnum
ALTER TYPE "UnitName" ADD VALUE 'hadiths';
ALTER TYPE "UnitName" ADD VALUE 'paragraphs';

-- AlterTable
ALTER TABLE "texts" ADD COLUMN     "sourceKind" "SourceKind" NOT NULL DEFAULT 'pdf';

-- CreateTable
CREATE TABLE "line_fragments" (
    "id" SERIAL NOT NULL,
    "lineId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" "FragmentKind" NOT NULL DEFAULT 'text',
    "page" INTEGER NOT NULL,
    "yTop" DOUBLE PRECISION NOT NULL,
    "yBottom" DOUBLE PRECISION NOT NULL,
    "xLeft" DOUBLE PRECISION,
    "xRight" DOUBLE PRECISION,

    CONSTRAINT "line_fragments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_files" (
    "id" SERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "fileId" TEXT NOT NULL,
    "fileUniqueId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSize" INTEGER,
    "mediaGroupId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upload_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "line_fragments_lineId_seq_key" ON "line_fragments"("lineId", "seq");

-- CreateIndex
CREATE INDEX "upload_files_userId_createdAt_idx" ON "upload_files"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "line_fragments" ADD CONSTRAINT "line_fragments_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "lines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "upload_files" ADD CONSTRAINT "upload_files_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Перенос уже разобранных строк: у каждой ровно один фрагмент — сама строка.
INSERT INTO "line_fragments" ("lineId", "seq", "kind", "page", "yTop", "yBottom", "xLeft", "xRight")
SELECT "id", 0, 'text', "page", "yTop", "yBottom", "xLeft", "xRight" FROM "lines";

-- AlterTable
ALTER TABLE "lines" DROP COLUMN "xLeft",
DROP COLUMN "xRight",
DROP COLUMN "yBottom",
DROP COLUMN "yTop";
