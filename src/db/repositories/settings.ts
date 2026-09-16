import type { SettingsStore } from '../../app/ports.js';
import type { Db } from '../client.js';

// Пересчёт цепочек повторов при смене часового пояса или времени (CLAUDE.md, раздел 5.5).

export function createSettingsRepository(db: Db): SettingsStore {
  return {
    async futureChains(userId, now) {
      const rows = await db.portion.findMany({
        where: {
          anchorAt: { not: null },
          status: 'learned',
          plan: { userId, status: { in: ['active', 'learning_done'] } },
        },
        select: {
          id: true,
          anchorAt: true,
          reviews: {
            where: { stage: { not: 'learn_reminder' }, status: 'pending', dueAt: { gt: now } },
            select: { id: true, stage: true },
          },
        },
      });
      return rows.flatMap(({ id, anchorAt, reviews }) =>
        anchorAt && reviews.length > 0
          ? [
              {
                portionId: id,
                anchorAt,
                stages: reviews.flatMap((r) =>
                  r.stage === 'learn_reminder' ? [] : [{ id: r.id, stage: r.stage }],
                ),
              },
            ]
          : [],
      );
    },

    async applyChain(portionId, anchorAt, updates) {
      await db.$transaction([
        db.portion.update({ where: { id: portionId }, data: { anchorAt } }),
        ...updates.map(({ id, dueAt }) => db.review.update({ where: { id }, data: { dueAt } })),
      ]);
    },
  };
}
