-- CreateEnum
CREATE TYPE "NightPolicy" AS ENUM ('keep', 'move');

-- CreateEnum
CREATE TYPE "UnitName" AS ENUM ('lines', 'bayts');

-- CreateEnum
CREATE TYPE "ParseStrategy" AS ENUM ('numbers', 'text_lines', 'image_lines', 'manual_page', 'manual_split');

-- CreateEnum
CREATE TYPE "TextStatus" AS ENUM ('parsing', 'awaiting_confirm', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "PaceMode" AS ENUM ('deadline', 'per_day');

-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('active', 'learning_done', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "PortionStatus" AS ENUM ('sent', 'learned', 'completed');

-- CreateEnum
CREATE TYPE "ReviewStage" AS ENUM ('learn_reminder', 'rep_12h', 'rep_1d', 'rep_3d', 'rep_2w', 'rep_1m');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'sent', 'confirmed', 'missed', 'cancelled');

-- CreateEnum
CREATE TYPE "DeliveryKind" AS ENUM ('portion', 'review_batch', 'debt_reminder', 'learn_reminder', 'pause_ending', 'autopause');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('sending', 'sent', 'confirmed', 'missed', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGINT NOT NULL,
    "username" TEXT,
    "timezone" TEXT,
    "dailySendTime" TEXT,
    "nightStart" TEXT NOT NULL DEFAULT '23:00',
    "nightEnd" TEXT NOT NULL DEFAULT '07:00',
    "nightPolicy" "NightPolicy" NOT NULL DEFAULT 'keep',
    "eveningReminderTime" TEXT NOT NULL DEFAULT '21:00',
    "learnReminderDelayMin" INTEGER NOT NULL DEFAULT 120,
    "onboardedAt" TIMESTAMP(3),
    "pausedFrom" TIMESTAMP(3),
    "pausedUntil" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dialog_states" (
    "userId" BIGINT NOT NULL,
    "flow" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dialog_states_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "texts" (
    "id" SERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "title" TEXT NOT NULL,
    "unitName" "UnitName" NOT NULL DEFAULT 'lines',
    "originalFileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "totalLines" INTEGER NOT NULL DEFAULT 0,
    "parseStrategy" "ParseStrategy",
    "status" "TextStatus" NOT NULL DEFAULT 'parsing',
    "parseReport" JSONB,
    "parseError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "texts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lines" (
    "id" SERIAL NOT NULL,
    "textId" INTEGER NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "printedNumber" INTEGER,
    "page" INTEGER NOT NULL,
    "yTop" DOUBLE PRECISION NOT NULL,
    "yBottom" DOUBLE PRECISION NOT NULL,
    "xLeft" DOUBLE PRECISION,
    "xRight" DOUBLE PRECISION,
    "sectionBreakBefore" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crop_cache" (
    "id" SERIAL NOT NULL,
    "textId" INTEGER NOT NULL,
    "cropKey" TEXT NOT NULL,
    "telegramFileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crop_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" SERIAL NOT NULL,
    "textId" INTEGER NOT NULL,
    "userId" BIGINT NOT NULL,
    "lineFrom" INTEGER NOT NULL,
    "lineTo" INTEGER NOT NULL,
    "unitsPerDay" INTEGER NOT NULL,
    "paceMode" "PaceMode" NOT NULL,
    "startDate" DATE NOT NULL,
    "deadlineDate" DATE,
    "deadlineInput" TEXT,
    "restDays" INTEGER[],
    "status" "PlanStatus" NOT NULL DEFAULT 'active',
    "nextLine" INTEGER NOT NULL,
    "estimatedEndDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portions" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "lineStart" INTEGER NOT NULL,
    "lineEnd" INTEGER NOT NULL,
    "status" "PortionStatus" NOT NULL DEFAULT 'sent',
    "sentAt" TIMESTAMP(3) NOT NULL,
    "learnedAt" TIMESTAMP(3),
    "anchorAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "portions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" SERIAL NOT NULL,
    "portionId" INTEGER NOT NULL,
    "stage" "ReviewStage" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "sentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "deliveryId" INTEGER,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" SERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "textId" INTEGER,
    "portionId" INTEGER,
    "kind" "DeliveryKind" NOT NULL,
    "slotAt" TIMESTAMP(3) NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'sending',
    "sentAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "messageIds" INTEGER[],
    "buttonsMessageId" INTEGER,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "texts_userId_idx" ON "texts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "texts_userId_sha256_key" ON "texts"("userId", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "lines_textId_lineNumber_key" ON "lines"("textId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "crop_cache_textId_cropKey_key" ON "crop_cache"("textId", "cropKey");

-- CreateIndex
CREATE INDEX "plans_userId_status_idx" ON "plans"("userId", "status");

-- CreateIndex
CREATE INDEX "portions_planId_status_idx" ON "portions"("planId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "portions_planId_seq_key" ON "portions"("planId", "seq");

-- CreateIndex
CREATE INDEX "reviews_status_dueAt_idx" ON "reviews"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_portionId_stage_key" ON "reviews"("portionId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_dedupeKey_key" ON "deliveries"("dedupeKey");

-- CreateIndex
CREATE INDEX "deliveries_userId_kind_slotAt_idx" ON "deliveries"("userId", "kind", "slotAt");

-- AddForeignKey
ALTER TABLE "dialog_states" ADD CONSTRAINT "dialog_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "texts" ADD CONSTRAINT "texts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lines" ADD CONSTRAINT "lines_textId_fkey" FOREIGN KEY ("textId") REFERENCES "texts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crop_cache" ADD CONSTRAINT "crop_cache_textId_fkey" FOREIGN KEY ("textId") REFERENCES "texts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_textId_fkey" FOREIGN KEY ("textId") REFERENCES "texts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portions" ADD CONSTRAINT "portions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_portionId_fkey" FOREIGN KEY ("portionId") REFERENCES "portions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_textId_fkey" FOREIGN KEY ("textId") REFERENCES "texts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_portionId_fkey" FOREIGN KEY ("portionId") REFERENCES "portions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
