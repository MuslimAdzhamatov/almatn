import type { NewKnownPortion, NewPlan, PlanRecord, PlansStore } from '../../app/ports.js';
import { dbDateToIso, isoToDbDate } from '../../core/plan/dates.js';
import { Prisma, type Plan } from '../../generated/prisma/client.js';
import type { Db } from '../client.js';

const OPEN_STATUSES = ['active', 'learning_done'] as const;

export function toPlanRecord(row: Plan): PlanRecord {
  return {
    id: row.id,
    textId: row.textId,
    userId: row.userId,
    lineFrom: row.lineFrom,
    lineTo: row.lineTo,
    unitsPerDay: row.unitsPerDay,
    paceMode: row.paceMode,
    startDate: dbDateToIso(row.startDate),
    deadlineDate: row.deadlineDate && dbDateToIso(row.deadlineDate),
    deadlineInput: row.deadlineInput,
    restDays: row.restDays,
    status: row.status,
    nextLine: row.nextLine,
    knownFrom: row.knownFrom,
    knownTo: row.knownTo,
    estimatedEndDate: row.estimatedEndDate && dbDateToIso(row.estimatedEndDate),
  };
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export function createPlansRepository(db: Db): PlansStore {
  return {
    async create(plan: NewPlan, known: readonly NewKnownPortion[] = []) {
      try {
        // План и уже известные единицы — одной транзакцией: иначе при сбое остался бы
        // план, в котором известное не повторяется.
        const row = await db.$transaction(async (tx) => {
          const created = await tx.plan.create({
            data: {
              ...plan,
              startDate: isoToDbDate(plan.startDate),
              deadlineDate: plan.deadlineDate && isoToDbDate(plan.deadlineDate),
              estimatedEndDate: plan.estimatedEndDate && isoToDbDate(plan.estimatedEndDate),
            },
          });
          for (const portion of known) {
            await tx.portion.create({
              data: {
                planId: created.id,
                seq: portion.seq,
                lineStart: portion.lineStart,
                lineEnd: portion.lineEnd,
                kind: 'known',
                status: 'learned',
                // Известное не выдавалось: выдачей считается слот, с которого пошли повторы.
                sentAt: portion.anchorAt,
                learnedAt: portion.anchorAt,
                anchorAt: portion.anchorAt,
                reviews: {
                  create: portion.reviews.map((r) => ({ stage: r.stage, dueAt: r.dueAt })),
                },
              },
            });
          }
          return created;
        });
        return toPlanRecord(row);
      } catch (err) {
        // plans_one_open_per_text: у текста уже есть открытый план.
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async findOpenByText(textId) {
      const row = await db.plan.findFirst({
        where: { textId, status: { in: [...OPEN_STATUSES] } },
      });
      return row ? toPlanRecord(row) : null;
    },

    async listOpenByUser(userId) {
      const rows = await db.plan.findMany({
        where: { userId, status: { in: [...OPEN_STATUSES] } },
        include: { text: { select: { title: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(({ text, ...row }) => ({ ...toPlanRecord(row), textTitle: text.title }));
    },

    async scheduledReviews(userId, exceptTextId) {
      const rows = await db.review.findMany({
        where: {
          stage: { not: 'learn_reminder' },
          status: { in: ['pending', 'sent', 'missed'] },
          portion: { plan: { userId, textId: { not: exceptTextId } } },
        },
        select: { dueAt: true, portion: { select: { lineStart: true, lineEnd: true } } },
      });
      return rows.map(({ dueAt, portion }) => ({
        dueAt,
        units: portion.lineEnd - portion.lineStart + 1,
      }));
    },
  };
}
