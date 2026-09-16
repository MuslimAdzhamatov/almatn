import type { LibraryStore } from '../../app/ports.js';
import type { Db } from '../client.js';
import { toPlanRecord } from './plans.js';

// Тексты пользователя, прогресс и удаление данных (CLAUDE.md, раздел 5.5).

export function createLibraryRepository(db: Db): LibraryStore {
  return {
    async listTexts(userId) {
      const rows = await db.text.findMany({
        where: { userId, status: 'ready' },
        orderBy: { createdAt: 'asc' },
        include: {
          plans: {
            where: { status: { in: ['active', 'learning_done', 'completed'] } },
            orderBy: { createdAt: 'desc' },
          },
        },
      });
      return rows.map(({ plans, ...text }) => {
        const open = plans.find((p) => p.status !== 'completed') ?? plans[0] ?? null;
        return {
          id: text.id,
          title: text.title,
          unitName: text.unitName,
          parseStrategy: text.parseStrategy ?? 'manual_page',
          totalLines: text.totalLines,
          plan: open && toPlanRecord(open),
        };
      });
    },

    async portions(planId) {
      return db.portion.findMany({
        where: { planId },
        orderBy: { seq: 'asc' },
        select: { lineStart: true, lineEnd: true, status: true, sentAt: true, learnedAt: true },
      });
    },

    async reviews(planId) {
      const rows = await db.review.findMany({
        where: {
          portion: { planId },
          stage: { not: 'learn_reminder' },
          status: { not: 'cancelled' },
        },
        orderBy: { dueAt: 'asc' },
        select: {
          dueAt: true,
          status: true,
          confirmedAt: true,
          portion: { select: { lineStart: true, lineEnd: true } },
        },
      });
      return rows.map(({ portion, ...row }) => ({ ...row, ...portion }));
    },

    async deleteText(userId, textId) {
      const deleted = await db.text.deleteMany({ where: { id: textId, userId } });
      return deleted.count > 0;
    },

    async deleteUser(userId) {
      return db.$transaction(async (tx) => {
        const texts = await tx.text.findMany({ where: { userId }, select: { id: true } });
        await tx.user.deleteMany({ where: { id: userId } });
        return texts.map((t) => t.id);
      });
    },
  };
}
