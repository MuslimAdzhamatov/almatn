import type { NewPlan, PlanRecord, PlansStore } from '../../app/ports.js';
import { dbDateToIso, isoToDbDate } from '../../core/plan/dates.js';
import { Prisma, type Plan } from '../../generated/prisma/client.js';
import type { Db } from '../client.js';

const OPEN_STATUSES = ['active', 'learning_done'] as const;

function toRecord(row: Plan): PlanRecord {
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
    estimatedEndDate: row.estimatedEndDate && dbDateToIso(row.estimatedEndDate),
  };
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export function createPlansRepository(db: Db): PlansStore {
  return {
    async create(plan: NewPlan) {
      try {
        const row = await db.plan.create({
          data: {
            ...plan,
            startDate: isoToDbDate(plan.startDate),
            deadlineDate: plan.deadlineDate && isoToDbDate(plan.deadlineDate),
            estimatedEndDate: plan.estimatedEndDate && isoToDbDate(plan.estimatedEndDate),
          },
        });
        return toRecord(row);
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
      return row ? toRecord(row) : null;
    },

    async listOpenByUser(userId) {
      const rows = await db.plan.findMany({
        where: { userId, status: { in: [...OPEN_STATUSES] } },
        include: { text: { select: { title: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(({ text, ...row }) => ({ ...toRecord(row), textTitle: text.title }));
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
