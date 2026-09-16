import { diffDays, localDate, parseUserDate } from '../core/plan/dates.js';
import {
  isPausePreset,
  pauseEndDate,
  pauseShiftDays,
  pauseWarningDue,
  shiftDate,
} from '../core/plan/pausing.js';
import { shouldAutoPause } from '../core/scheduler/batch.js';
import { hasDebt } from '../core/scheduler/rules.js';
import { mainSlotOn } from '../core/srs/slots.js';
import type { Images } from './images.js';
import { isPaused, type Learning } from './learning.js';
import type {
  DialogStore,
  LearnerSettings,
  LearningStore,
  Notice,
  Notifier,
  PlanContext,
  PlanShift,
} from './ports.js';
import type { Reviews } from './reviews.js';
import { settleSend } from './sending.js';

// Пауза (CLAUDE.md, разделы 5.2 и 5.5): ручная (/pause) и автопауза, предупреждение накануне,
// окончание паузы — сводка всего долга и сдвиг сроков планов на длительность паузы.

const FLOW = 'pause';
/** Дальше года паузу не ставим. */
const MAX_PAUSE_DAYS = 365;

export interface PauseDeps {
  store: LearningStore;
  notifier: Notifier;
  images: Images;
  learning: Learning;
  reviews: Reviews;
  dialogs: DialogStore;
  reportError?: (err: unknown, context: Record<string, unknown>) => void;
}

export type ResumeResult =
  { kind: 'resumed'; debtMessages: number; shifted: PlanShift[] } | { kind: 'not_paused' };

export type PauseScreen =
  | { kind: 'menu' }
  | { kind: 'ask_date'; invalid: boolean; maxDays: number }
  /** until = null — до ручного продолжения. */
  | { kind: 'paused'; until: Date | null; timezone: string }
  | ResumeResult
  | { kind: 'stale' };

export function createPause({
  store,
  notifier,
  images,
  learning,
  reviews,
  dialogs,
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

  async function userPlans(userId: bigint) {
    return (await store.listOpenPlans()).filter((ctx) => ctx.user.userId === userId);
  }

  /** Служебное сообщение с записью в журнале; false — не дошло (запись удалена). */
  async function notify(
    userId: bigint,
    kind: 'autopause' | 'pause_ending',
    dedupeKey: string,
    notice: Notice,
    now: Date,
  ): Promise<boolean | null> {
    const deliveryId = await store.createDelivery({
      userId,
      textId: null,
      portionId: null,
      kind,
      slotAt: now,
      dedupeKey,
    });
    if (deliveryId === null) return null;
    let ok = false;
    try {
      const result = await notifier.sendNotice(userId, notice);
      ok = await settleSend(sending, { userId, textId: null, deliveryId }, result, [], now);
      if (!result.ok && result.reason === 'blocked') ok = true;
    } catch (err) {
      reportError(err, { userId: String(userId), kind });
    }
    if (!ok) await store.deleteDelivery(deliveryId);
    return ok;
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
    const key = `autopause:${userId}:${user.lastActivityAt.toISOString()}`;
    await store.setPause(userId, now, null);
    const sent = await notify(userId, 'autopause', key, { kind: 'autopause' }, now);
    // Пользователь не узнал о паузе — не ставим её молча, следующий тик попробует снова.
    if (sent !== true) await store.setPause(userId, user.pausedFrom, user.pausedUntil);
  }

  /** Сроки открытых планов сдвигаются на длительность паузы. */
  async function shiftPlans(plans: PlanContext[], days: number): Promise<PlanShift[]> {
    const shifted: PlanShift[] = [];
    for (const { plan, text } of plans) {
      if (plan.status !== 'active' || days === 0) continue;
      const estimatedEndDate = shiftDate(plan.estimatedEndDate, days);
      await store.updatePlan(plan.id, {
        estimatedEndDate,
        deadlineDate: shiftDate(plan.deadlineDate, days),
      });
      shifted.push({ title: text.title, endDate: estimatedEndDate });
    }
    return shifted;
  }

  /** Снять паузу: сдвиг сроков, сводка всего долга, порция — если пора. */
  async function finish(user: LearnerSettings, endedAt: Date, now: Date): Promise<ResumeResult> {
    const { userId } = user;
    const plans = await userPlans(userId);
    const days = user.pausedFrom ? pauseShiftDays(user.pausedFrom, endedAt, user.timezone) : 0;
    await store.setPause(userId, null, null);
    // Семь дней бездействия для автопаузы считаются от конца паузы.
    await store.resetActivity(userId, now);
    const shifted = await shiftPlans(plans, days);
    const debtMessages = await reviews.sendDebtNow(userId, now);
    for (const ctx of plans) {
      if (ctx.plan.status === 'active') await learning.issueIfDue(ctx.plan.id, now);
    }
    return { kind: 'resumed', debtMessages, shifted };
  }

  async function timedPause(user: LearnerSettings, now: Date) {
    const { userId, pausedFrom, pausedUntil } = user;
    if (!pausedFrom || !pausedUntil) return;
    if (pausedUntil <= now) {
      const result = await finish(user, pausedUntil, now);
      if (result.kind === 'resumed') {
        const { debtMessages, shifted } = result;
        await notifier
          .sendNotice(userId, { kind: 'pause_ended', debtMessages, shifted })
          .catch((err: unknown) => reportError(err, { userId: String(userId) }));
      }
      return;
    }
    if (pauseWarningDue(pausedFrom, pausedUntil, now)) {
      const key = `pause_warning:${userId}:${pausedUntil.toISOString()}`;
      const notice = {
        kind: 'pause_warning' as const,
        until: pausedUntil,
        timezone: user.timezone,
      };
      await notify(userId, 'pause_ending', key, notice, now);
    }
  }

  async function setPause(userId: bigint, until: Date | null, now: Date): Promise<PauseScreen> {
    const user = await store.learner(userId);
    if (!user) return { kind: 'stale' };
    await dialogs.clear(userId);
    // Пауза продлевается — сдвиг сроков считается от её настоящего начала.
    const from = isPaused(user, now) && user.pausedFrom ? user.pausedFrom : now;
    await store.setPause(userId, from, until);
    return { kind: 'paused', until, timezone: user.timezone };
  }

  return {
    /** Шаг тика (app/tick.ts): окончание пауз, предупреждение накануне, автопауза. */
    async runDue(now: Date): Promise<void> {
      for (const user of await store.listTimedPauses()) {
        try {
          await timedPause(user, now);
        } catch (err) {
          reportError(err, { userId: String(user.userId) });
        }
      }
      const byUser = new Map<bigint, PlanContext[]>();
      for (const ctx of await store.listOpenPlans()) {
        byUser.set(ctx.user.userId, [...(byUser.get(ctx.user.userId) ?? []), ctx]);
      }
      for (const [userId, plans] of byUser) {
        try {
          await autoPause(userId, plans, now);
        } catch (err) {
          reportError(err, { userId: String(userId) });
        }
      }
    },

    /** /pause: меню длительности или текущая пауза. */
    async open(userId: bigint, now: Date): Promise<PauseScreen> {
      const user = await store.learner(userId);
      if (!user) return { kind: 'stale' };
      if (isPaused(user, now)) {
        return { kind: 'paused', until: user.pausedUntil, timezone: user.timezone };
      }
      return { kind: 'menu' };
    },

    /** Кнопка меню: d1 / w1 / w2 / w3 / m1, date — спросить дату, manual — до продолжения. */
    async choose(userId: bigint, choice: string, now: Date): Promise<PauseScreen> {
      const user = await store.learner(userId);
      if (!user) return { kind: 'stale' };
      if (choice === 'manual') return setPause(userId, null, now);
      if (choice === 'date') {
        await dialogs.set(userId, { flow: FLOW, step: 'date', data: {} });
        return { kind: 'ask_date', invalid: false, maxDays: MAX_PAUSE_DAYS };
      }
      if (!isPausePreset(choice)) return { kind: 'stale' };
      const date = pauseEndDate(localDate(now, user.timezone), choice);
      return setPause(userId, mainSlotOn(date, user), now);
    },

    /** Дата окончания паузы текстом; null — пользователь не в этом диалоге. */
    async handleText(userId: bigint, input: string, now: Date): Promise<PauseScreen | null> {
      const dialog = await dialogs.get(userId);
      if (dialog?.flow !== FLOW) return null;
      const user = await store.learner(userId);
      if (!user) return null;
      const today = localDate(now, user.timezone);
      const date = parseUserDate(input);
      if (!date || date <= today || diffDays(today, date) > MAX_PAUSE_DAYS) {
        return { kind: 'ask_date', invalid: true, maxDays: MAX_PAUSE_DAYS };
      }
      return setPause(userId, mainSlotOn(date, user), now);
    },

    /** «Продолжить» / «Продолжить сейчас». */
    async resume(userId: bigint, now: Date): Promise<ResumeResult> {
      const user = await store.learner(userId);
      if (!user || !isPaused(user, now)) {
        if (user?.pausedFrom) await store.setPause(userId, null, null);
        return { kind: 'not_paused' };
      }
      return finish(user, now, now);
    },
  };
}

export type Pause = ReturnType<typeof createPause>;
