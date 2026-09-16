import { shouldAutoPause } from '../core/scheduler/batch.js';
import { hasDebt } from '../core/scheduler/rules.js';
import type { Images } from './images.js';
import { isPaused, type Learning } from './learning.js';
import type { LearningStore, Notifier, PlanContext } from './ports.js';
import type { Reviews } from './reviews.js';
import { settleSend } from './sending.js';

// Автопауза (CLAUDE.md, раздел 5.2) и продолжение после паузы. Ручная пауза (/pause) — этап 7.

export interface PauseDeps {
  store: LearningStore;
  notifier: Notifier;
  images: Images;
  learning: Learning;
  reviews: Reviews;
  reportError?: (err: unknown, context: Record<string, unknown>) => void;
}

export type ResumeResult = { kind: 'resumed'; debtMessages: number } | { kind: 'not_paused' };

export function createPause({
  store,
  notifier,
  images,
  learning,
  reviews,
  reportError = () => undefined,
}: PauseDeps) {
  const sending = { store, images, reportError };

  async function textHasDebt(ctx: PlanContext, now: Date): Promise<boolean> {
    const unlearned =
      ctx.plan.status === 'active' ? await store.unlearnedPortion(ctx.plan.id) : null;
    return hasDebt(now, {
      unlearnedPortion: unlearned !== null,
      reviews: await store.textReviews(ctx.text.id),
    });
  }

  async function plansByUser() {
    const byUser = new Map<bigint, PlanContext[]>();
    for (const ctx of await store.listOpenPlans()) {
      byUser.set(ctx.user.userId, [...(byUser.get(ctx.user.userId) ?? []), ctx]);
    }
    return byUser;
  }

  async function autoPause(userId: bigint, plans: PlanContext[], now: Date) {
    const { user } = plans[0]!;
    if (user.blockedAt || isPaused(user, now)) return;
    // Дешёвая проверка до подсчёта долга: активность была недавно.
    if (!shouldAutoPause(user.lastActivityAt, now, true)) return;
    let debt = false;
    for (const ctx of plans) debt ||= await textHasDebt(ctx, now);
    if (!shouldAutoPause(user.lastActivityAt, now, debt)) return;

    // Одна автопауза на период бездействия: «Продолжить» — это уже активность.
    const deliveryId = await store.createDelivery({
      userId,
      textId: null,
      portionId: null,
      kind: 'autopause',
      slotAt: now,
      dedupeKey: `autopause:${userId}:${user.lastActivityAt.toISOString()}`,
    });
    if (deliveryId === null) return;
    await store.setPause(userId, now, null);
    let ok = false;
    try {
      const result = await notifier.sendAutoPause(userId);
      ok = await settleSend(sending, { userId, textId: null, deliveryId }, result, [], now);
      if (!result.ok && result.reason === 'blocked') ok = true;
    } catch (err) {
      reportError(err, { userId: String(userId) });
    }
    if (!ok) {
      // Пользователь не узнал о паузе — не ставим её молча, следующий тик попробует снова.
      await store.setPause(userId, null, null);
      await store.deleteDelivery(deliveryId);
    }
  }

  return {
    /** Шаг тика (app/tick.ts): 7 дней без активности при долге — пауза до ручного продолжения. */
    async runDue(now: Date): Promise<void> {
      for (const [userId, plans] of await plansByUser()) {
        try {
          await autoPause(userId, plans, now);
        } catch (err) {
          reportError(err, { userId: String(userId) });
        }
      }
    },

    /** «Продолжить»: пауза снимается, сначала приходит сводка всего долга. */
    async resume(userId: bigint, now: Date): Promise<ResumeResult> {
      const plans = (await plansByUser()).get(userId) ?? [];
      const paused = plans[0] ? isPaused(plans[0].user, now) : false;
      await store.setPause(userId, null, null);
      if (!paused) return { kind: 'not_paused' };
      const debtMessages = await reviews.sendDebtNow(userId, now);
      for (const ctx of plans) {
        if (ctx.plan.status === 'active') await learning.issueIfDue(ctx.plan.id, now);
      }
      return { kind: 'resumed', debtMessages };
    },
  };
}

export type Pause = ReturnType<typeof createPause>;
