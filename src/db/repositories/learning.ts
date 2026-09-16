import {
  BATCH_KINDS,
  type CropCacheStore,
  type DeliveryRecord,
  type LearningStore,
  type PlanContext,
  type PortionRecord,
  type ReviewRow,
} from '../../app/ports.js';
import { isoToDbDate } from '../../core/plan/dates.js';
import {
  Prisma,
  type Delivery,
  type Line,
  type LineFragment,
  type Plan,
  type PlanStatus,
  type Portion,
  type Text,
  type User,
} from '../../generated/prisma/client.js';
import type { Db } from '../client.js';
import { toPlanRecord } from './plans.js';

/** Ключ advisory lock тика планировщика — один на все экземпляры бота. */
const TICK_LOCK_KEY = 7_120_001;
/** Тик может идти долго (рендер и отправка картинок), поэтому таймаут транзакции с блокировкой большой. */
const TICK_TIMEOUT_MS = 10 * 60 * 1000;

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

type PlanRow = Plan & { text: Text; user: User };

const planInclude = { text: true, user: true } as const;

function toContext({ text, user, ...plan }: PlanRow): PlanContext | null {
  if (!user.timezone || !user.dailySendTime) return null;
  return {
    plan: toPlanRecord(plan),
    text: {
      id: text.id,
      title: text.title,
      unitName: text.unitName,
      parseStrategy: text.parseStrategy ?? 'manual_page',
      sourceKind: text.sourceKind,
      filePath: text.filePath,
      totalLines: text.totalLines,
    },
    user: {
      userId: user.id,
      timezone: user.timezone,
      dailySendTime: user.dailySendTime,
      eveningReminderTime: user.eveningReminderTime,
      nightStart: user.nightStart,
      nightEnd: user.nightEnd,
      nightPolicy: user.nightPolicy,
      learnReminderDelayMin: user.learnReminderDelayMin,
      pausedFrom: user.pausedFrom,
      pausedUntil: user.pausedUntil,
      blockedAt: user.blockedAt,
    },
  };
}

const toPortion = (row: Portion): PortionRecord => ({
  id: row.id,
  planId: row.planId,
  seq: row.seq,
  lineStart: row.lineStart,
  lineEnd: row.lineEnd,
  status: row.status,
  sentAt: row.sentAt,
  learnedAt: row.learnedAt,
  anchorAt: row.anchorAt,
});

const reviewSelect = {
  id: true,
  portionId: true,
  dueAt: true,
  status: true,
  portion: { select: { lineStart: true, lineEnd: true } },
} as const;

const toReviewRow = ({
  portion,
  ...row
}: {
  id: number;
  portionId: number;
  dueAt: Date;
  status: ReviewRow['status'];
  portion: { lineStart: number; lineEnd: number };
}): ReviewRow => ({ ...row, ...portion });

const toDelivery = (row: Delivery): DeliveryRecord => ({
  id: row.id,
  userId: row.userId,
  textId: row.textId,
  portionId: row.portionId,
  kind: row.kind,
  status: row.status,
  slotAt: row.slotAt,
  messageIds: row.messageIds,
  buttonsMessageId: row.buttonsMessageId,
  cropMarginSteps: row.cropMarginSteps,
  extraBefore: row.extraBefore,
  extraAfter: row.extraAfter,
});

function toBox(row: Line & { fragments: LineFragment[] }) {
  return {
    lineNumber: row.lineNumber,
    printedNumber: row.printedNumber,
    page: row.page,
    sectionBreakBefore: row.sectionBreakBefore,
    skipped: row.skipped,
    fragments: row.fragments.map(({ kind, page, yTop, yBottom, xLeft, xRight }) => ({
      kind,
      page,
      yTop,
      yBottom,
      xLeft,
      xRight,
    })),
  };
}

export function createLearningRepository(db: Db): LearningStore {
  const learnReminder = (portionId: number) => ({
    portionId_stage: { portionId, stage: 'learn_reminder' as const },
  });

  async function listPlans(statuses: PlanStatus[]) {
    const rows = await db.plan.findMany({
      where: {
        status: { in: statuses },
        text: { status: 'ready' },
        user: { onboardedAt: { not: null }, blockedAt: null },
      },
      include: planInclude,
      orderBy: { id: 'asc' },
    });
    return rows.map(toContext).filter((ctx) => ctx !== null);
  }

  return {
    async withTickLock(fn) {
      return db.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${TICK_LOCK_KEY}) AS locked`;
          return row?.locked ? fn() : null;
        },
        { timeout: TICK_TIMEOUT_MS, maxWait: 10_000 },
      );
    },

    listActivePlans: () => listPlans(['active']),

    listOpenPlans: () => listPlans(['active', 'learning_done']),

    async textPlanContext(textId) {
      const row = await db.plan.findFirst({
        where: { textId, status: { in: ['active', 'learning_done'] } },
        include: planInclude,
      });
      return row ? toContext(row) : null;
    },

    async planContext(planId) {
      const row = await db.plan.findUnique({ where: { id: planId }, include: planInclude });
      return row ? toContext(row) : null;
    },

    async lastPortion(planId) {
      const row = await db.portion.findFirst({ where: { planId }, orderBy: { seq: 'desc' } });
      return row && toPortion(row);
    },

    async getPortion(portionId) {
      const row = await db.portion.findUnique({ where: { id: portionId } });
      return row && toPortion(row);
    },

    async unlearnedPortion(planId) {
      const row = await db.portion.findFirst({
        where: { planId, status: 'sent' },
        orderBy: { seq: 'asc' },
      });
      return row && toPortion(row);
    },

    async textReviews(textId) {
      const rows = await db.review.findMany({
        where: {
          stage: { not: 'learn_reminder' },
          status: { in: ['pending', 'sent', 'missed'] },
          portion: { plan: { textId } },
        },
        select: reviewSelect,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(toReviewRow);
    },

    async deliveryReviews(deliveryId) {
      const rows = await db.review.findMany({
        where: { deliveryId, stage: { not: 'learn_reminder' } },
        select: reviewSelect,
        orderBy: { id: 'asc' },
      });
      return rows.map(toReviewRow);
    },

    async attachReviews(deliveryId, reviewIds, at) {
      if (reviewIds.length === 0) return;
      await db.review.updateMany({
        where: { id: { in: [...reviewIds] }, status: { in: ['pending', 'sent', 'missed'] } },
        data: { status: 'sent', sentAt: at, deliveryId },
      });
    },

    async answerReviews(deliveryId, answer, at) {
      return db.$transaction(async (tx) => {
        const updated = await tx.review.updateMany({
          where: {
            deliveryId,
            stage: { not: 'learn_reminder' },
            status: { in: answer === 'confirmed' ? ['sent', 'missed'] : ['sent'] },
          },
          data:
            answer === 'confirmed'
              ? { status: 'confirmed', confirmedAt: at }
              : { status: 'missed' },
        });
        await tx.delivery.update({ where: { id: deliveryId }, data: { answeredAt: at } });
        return updated.count;
      });
    },

    async openBatchDeliveries(textId) {
      const rows = await db.delivery.findMany({
        where: { textId, kind: { in: [...BATCH_KINDS] }, status: 'sent' },
        orderBy: { id: 'asc' },
      });
      return rows.map(toDelivery);
    },

    async unitRows(textId, from, to) {
      if (to < from) return [];
      return db.line.findMany({
        where: { textId, lineNumber: { gte: from, lte: to } },
        select: { lineNumber: true, skipped: true },
        orderBy: { lineNumber: 'asc' },
      });
    },

    async unitBoxes(textId, from, to) {
      if (to < from) return [];
      const rows = await db.line.findMany({
        where: { textId, lineNumber: { gte: from, lte: to } },
        include: { fragments: { orderBy: { seq: 'asc' } } },
        orderBy: { lineNumber: 'asc' },
      });
      return rows.map(toBox);
    },

    async createPortion(p) {
      try {
        return await db.$transaction(async (tx) => {
          const moved = await tx.plan.updateMany({
            where: { id: p.planId, status: 'active', nextLine: p.expectedNextLine },
            data: { nextLine: p.nextLine },
          });
          if (moved.count === 0) throw new StalePlan();
          const portion = await tx.portion.create({
            data: {
              planId: p.planId,
              seq: p.seq,
              lineStart: p.lineStart,
              lineEnd: p.lineEnd,
              sentAt: p.sentAt,
            },
          });
          await tx.review.create({
            data: { portionId: portion.id, stage: 'learn_reminder', dueAt: p.learnReminderAt },
          });
          const delivery = await tx.delivery.create({
            data: { ...p.delivery, portionId: portion.id, kind: 'portion' },
          });
          return { portion: toPortion(portion), deliveryId: delivery.id };
        });
      } catch (err) {
        if (err instanceof StalePlan || isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async rollbackPortion(portionId, nextLine) {
      await db.$transaction(async (tx) => {
        const portion = await tx.portion.delete({ where: { id: portionId } });
        await tx.plan.update({ where: { id: portion.planId }, data: { nextLine } });
      });
    },

    async createDelivery(data) {
      try {
        return (await db.delivery.create({ data })).id;
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async markDeliverySent(deliveryId, messageIds, buttonsMessageId, at) {
      await db.delivery.update({
        where: { id: deliveryId },
        data: { status: 'sent', sentAt: at, messageIds, buttonsMessageId },
      });
    },

    async setDeliveryStatus(deliveryId, status, at) {
      await db.delivery.updateMany({
        where: { id: deliveryId },
        data: { status, ...(at && { answeredAt: at }) },
      });
    },

    async deleteDelivery(deliveryId) {
      await db.delivery.deleteMany({ where: { id: deliveryId } });
    },

    async getDelivery(deliveryId) {
      const row = await db.delivery.findUnique({ where: { id: deliveryId } });
      return row && toDelivery(row);
    },

    async updateDeliveryContext(deliveryId, patch) {
      await db.delivery.update({ where: { id: deliveryId }, data: patch });
    },

    async openPortionDeliveries(portionId) {
      const rows = await db.delivery.findMany({
        where: { portionId, status: 'sent', kind: { in: ['portion', 'learn_reminder'] } },
      });
      return rows.map(toDelivery);
    },

    countPortionDeliveries: (portionId) => db.delivery.count({ where: { portionId } }),

    async markLearned(portionId, learnedAt, anchorAt, reviews) {
      return db.$transaction(async (tx) => {
        const updated = await tx.portion.updateMany({
          where: { id: portionId, status: 'sent' },
          data: { status: 'learned', learnedAt, anchorAt },
        });
        if (updated.count === 0) return false;
        await tx.review.updateMany({
          where: { portionId, stage: 'learn_reminder', status: 'pending' },
          data: { status: 'cancelled' },
        });
        await tx.review.createMany({
          data: reviews.map(({ stage, dueAt }) => ({ portionId, stage, dueAt })),
          skipDuplicates: true,
        });
        return true;
      });
    },

    async cancelLearnReminder(portionId) {
      await db.review.updateMany({
        where: { portionId, stage: 'learn_reminder', status: 'pending' },
        data: { status: 'cancelled' },
      });
    },

    async rescheduleLearnReminder(portionId, dueAt) {
      await db.review.upsert({
        where: learnReminder(portionId),
        create: { portionId, stage: 'learn_reminder', dueAt },
        update: { dueAt, status: 'pending', sentAt: null },
      });
    },

    async dueLearnReminders(now) {
      const rows = await db.review.findMany({
        where: {
          stage: 'learn_reminder',
          status: 'pending',
          dueAt: { lte: now },
          portion: { status: 'sent', plan: { status: 'active' } },
        },
        include: { portion: { include: { plan: { include: planInclude } } } },
        orderBy: { dueAt: 'asc' },
      });
      return rows.flatMap(({ id, dueAt, portion: { plan, ...portion } }) => {
        const context = toContext(plan);
        return context ? [{ reviewId: id, dueAt, portion: toPortion(portion), context }] : [];
      });
    },

    async claimLearnReminder(reviewId) {
      const claimed = await db.review.updateMany({
        where: { id: reviewId, status: 'pending' },
        data: { status: 'sent', sentAt: new Date() },
      });
      return claimed.count === 1;
    },

    async releaseLearnReminder(reviewId) {
      await db.review.updateMany({
        where: { id: reviewId, status: 'sent' },
        data: { status: 'pending', sentAt: null },
      });
    },

    async markSkipped(textId, lineNumbers) {
      await db.line.updateMany({
        where: { textId, lineNumber: { in: [...lineNumbers] } },
        data: { skipped: true },
      });
    },

    async updatePortionRange(portionId, lineStart, lineEnd) {
      await db.portion.update({ where: { id: portionId }, data: { lineStart, lineEnd } });
    },

    async deletePortion(portionId) {
      await db.portion.deleteMany({ where: { id: portionId } });
    },

    async updatePlan(planId, { estimatedEndDate, ...patch }) {
      await db.plan.update({
        where: { id: planId },
        data: {
          ...patch,
          ...(estimatedEndDate !== undefined && {
            estimatedEndDate: estimatedEndDate && isoToDbDate(estimatedEndDate),
          }),
        },
      });
    },

    countUnits: (textId, from, to) =>
      to < from
        ? Promise.resolve(0)
        : db.line.count({ where: { textId, skipped: false, lineNumber: { gte: from, lte: to } } }),

    async setBlocked(userId, at) {
      await db.user.update({ where: { id: userId }, data: { blockedAt: at } });
    },
  };
}

class StalePlan extends Error {
  constructor() {
    super('План изменился — порцию уже выдали');
  }
}

export function createCropCacheRepository(db: Db): CropCacheStore {
  return {
    async get(textId, keys) {
      if (keys.length === 0) return new Map();
      const rows = await db.cropCache.findMany({
        where: { textId, cropKey: { in: [...keys] } },
        select: { cropKey: true, telegramFileId: true },
      });
      return new Map(rows.map((row) => [row.cropKey, row.telegramFileId]));
    },

    async save(textId, entries) {
      await db.cropCache.createMany({
        data: entries.map(({ cacheKey, fileId }) => ({
          textId,
          cropKey: cacheKey,
          telegramFileId: fileId,
        })),
        skipDuplicates: true,
      });
    },
  };
}
