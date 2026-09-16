import { limits } from '../config/limits.js';
import type { IsoDate } from '../core/plan/dates.js';
import {
  decideIssue,
  estimateEndDate,
  hasDebt,
  pickPortion,
  type IssueDecision,
} from '../core/scheduler/rules.js';
import {
  applyQuietHours,
  nearestSlot,
  planningDayOf,
  reviewChain,
  type ScheduledStage,
} from '../core/srs/slots.js';
import type { Images, OutgoingPicture } from './images.js';
import type {
  DeliveryRecord,
  LearnerSettings,
  LearningStore,
  Notifier,
  PlanContext,
  PortionRecord,
  PortionView,
  SendResult,
  UnitLabel,
} from './ports.js';

// Выдача порций и ответы на них (CLAUDE.md, разделы 4.1, 5, 5.2, 5.6):
// тик планировщика, «Выучил» / «Ещё учу» / «Напомнить позже», пропуск единиц и кнопки контекста.

const MINUTE = 60 * 1000;

export interface LearningDeps {
  store: LearningStore;
  notifier: Notifier;
  images: Images;
  reportError?: (err: unknown, context: Record<string, unknown>) => void;
}

export interface PortionInfo extends UnitLabel {
  title: string;
  lineStart: number;
  lineEnd: number;
  timezone: string;
}

/** Что будет с новой порцией после действия пользователя. */
export type NextPortion =
  | { kind: 'sent' }
  | { kind: 'at'; at: Date }
  | { kind: 'debt' }
  | { kind: 'done' }
  | { kind: 'paused' }
  /** Отправить не получилось — планировщик попробует снова. */
  | { kind: 'retry' };

export type PortionAction =
  | { kind: 'learned'; portion: PortionInfo; reviews: ScheduledStage[]; next: NextPortion }
  | { kind: 'already_learned'; portion: PortionInfo }
  | { kind: 'still_learning'; portion: PortionInfo }
  | { kind: 'remind_later'; portion: PortionInfo; at: Date }
  | { kind: 'context_sent' }
  | { kind: 'context_limit'; direction: 'more' | 'up' | 'down'; max: number }
  | { kind: 'context_edge'; direction: 'up' | 'down'; unit: UnitLabel }
  | {
      kind: 'skip_menu';
      deliveryId: number;
      portion: PortionInfo;
      units: number[];
      /** Выбранные единицы — битовая маска по индексам units (null — выбор не предлагается). */
      mask: bigint | null;
    }
  | {
      kind: 'skipped';
      portion: PortionInfo;
      skipped: number[];
      /** Порция заменена и прислана заново; false — учить в плане больше нечего. */
      replaced: boolean;
      endDate: IsoDate | null;
    }
  | { kind: 'failed' }
  | { kind: 'stale' };

const isPaused = (user: LearnerSettings, now: Date) =>
  user.pausedFrom !== null &&
  user.pausedFrom <= now &&
  (user.pausedUntil === null || user.pausedUntil > now);

const unitLabel = (ctx: PlanContext): UnitLabel => ({
  unitName: ctx.text.unitName,
  strategy: ctx.text.parseStrategy,
});

function portionInfo(ctx: PlanContext, portion: Pick<PortionRecord, 'lineStart' | 'lineEnd'>) {
  return {
    ...unitLabel(ctx),
    title: ctx.text.title,
    lineStart: portion.lineStart,
    lineEnd: portion.lineEnd,
    timezone: ctx.user.timezone,
  };
}

const toNotifier = (pictures: readonly OutgoingPicture[]) =>
  pictures.map(({ fileId, png, lineStart, lineEnd }) => ({ fileId, png, lineStart, lineEnd }));

export function parseMask(value: string): bigint | null {
  return /^[0-9a-f]{1,16}$/.test(value) ? BigInt(`0x${value}`) : null;
}

export const formatMask = (mask: bigint) => mask.toString(16);

export function createLearning({
  store,
  notifier,
  images,
  reportError = () => undefined,
}: LearningDeps) {
  const L = limits.learning;

  async function debtOf(ctx: PlanContext, now: Date): Promise<boolean> {
    const unlearned = await store.unlearnedPortion(ctx.plan.id);
    const reviews = await store.textReviews(ctx.text.id);
    return hasDebt(now, { unlearnedPortion: unlearned !== null, reviews });
  }

  async function nextUnits(ctx: PlanContext, from: number) {
    const { plan } = ctx;
    const rows = await store.unitRows(ctx.text.id, from, plan.lineTo);
    return pickPortion(rows, from, plan.lineTo, plan.unitsPerDay);
  }

  async function decide(ctx: PlanContext, now: Date): Promise<IssueDecision> {
    const { plan, user } = ctx;
    if (plan.status !== 'active') return { kind: 'blocked', reason: 'done' };
    const last = await store.lastPortion(plan.id);
    return decideIssue({
      now,
      rules: user,
      startDate: plan.startDate,
      restDays: plan.restDays,
      lastPortionSentAt: last?.sentAt ?? null,
      debt: await debtOf(ctx, now),
      hasUnits: (await nextUnits(ctx, plan.nextLine)) !== null,
    });
  }

  /** Все единицы выданы и выучены — заучивание по плану закончено. */
  async function finishIfLearned(ctx: PlanContext) {
    if (ctx.plan.status !== 'active') return;
    if ((await nextUnits(ctx, ctx.plan.nextLine)) !== null) return;
    if (await store.unlearnedPortion(ctx.plan.id)) return;
    await store.updatePlan(ctx.plan.id, { status: 'learning_done' });
  }

  /** Результат отправки: file_id — в кэш, 403 — пользователь заблокировал бота. */
  async function handleSent(
    ctx: PlanContext,
    result: SendResult,
    deliveryId: number,
    pictures: readonly OutgoingPicture[],
    now: Date,
  ): Promise<boolean> {
    if (result.ok) {
      await store.markDeliverySent(deliveryId, result.messageIds, result.buttonsMessageId, now);
      await images.remember(
        ctx.text.id,
        pictures.flatMap((picture, index) => {
          const fileId = result.fileIds[index];
          return picture.png && fileId ? [{ cacheKey: picture.cacheKey, fileId }] : [];
        }),
      );
      return true;
    }
    if (result.reason === 'blocked') await store.setBlocked(ctx.user.userId, now);
    else reportError(result.error, { deliveryId, planId: ctx.plan.id });
    return false;
  }

  async function sendPortion(
    ctx: PlanContext,
    portion: Pick<PortionRecord, 'lineStart' | 'lineEnd'>,
    deliveryId: number,
    replaced: boolean,
    now: Date,
  ): Promise<boolean> {
    const boxes = (await store.unitBoxes(ctx.text.id, portion.lineStart, portion.lineEnd)).filter(
      (box) => !box.skipped,
    );
    const pictures = await images.pictures(ctx.text, boxes);
    const view: PortionView = {
      ...portionInfo(ctx, portion),
      deliveryId,
      count: boxes.length,
      replaced,
    };
    const result = await notifier.sendPortion(ctx.user.userId, view, toNotifier(pictures));
    return handleSent(ctx, result, deliveryId, pictures, now);
  }

  /** Выдать следующую порцию плана сейчас (правило уже проверено). */
  async function issue(ctx: PlanContext, now: Date): Promise<boolean> {
    const { plan, user, text } = ctx;
    const units = await nextUnits(ctx, plan.nextLine);
    if (!units) {
      await finishIfLearned(ctx);
      return false;
    }
    const seq = ((await store.lastPortion(plan.id))?.seq ?? 0) + 1;
    const created = await store.createPortion({
      planId: plan.id,
      seq,
      lineStart: units.lineStart,
      lineEnd: units.lineEnd,
      sentAt: now,
      expectedNextLine: plan.nextLine,
      nextLine: units.lineEnd + 1,
      learnReminderAt: new Date(now.getTime() + user.learnReminderDelayMin * MINUTE),
      delivery: {
        userId: user.userId,
        textId: text.id,
        slotAt: now,
        dedupeKey: `portion:${plan.id}:${seq}`,
      },
    });
    // Порцию уже выдал параллельный вызов (тик и «Выучил» одновременно).
    if (!created) return false;
    try {
      if (await sendPortion(ctx, created.portion, created.deliveryId, false, now)) return true;
    } catch (err) {
      reportError(err, { planId: plan.id, seq });
    }
    await store.rollbackPortion(created.portion.id, plan.nextLine);
    return false;
  }

  async function issueIfDue(planId: number, now: Date): Promise<NextPortion> {
    const ctx = await store.planContext(planId);
    if (!ctx) return { kind: 'done' };
    if (isPaused(ctx.user, now)) return { kind: 'paused' };
    const decision = await decide(ctx, now);
    if (decision.kind === 'now') {
      return (await issue(ctx, now)) ? { kind: 'sent' } : { kind: 'retry' };
    }
    if (decision.kind === 'blocked' && decision.reason === 'done') await finishIfLearned(ctx);
    return toNext(decision);
  }

  function toNext(decision: IssueDecision): NextPortion {
    if (decision.kind === 'at') return { kind: 'at', at: decision.at };
    if (decision.kind === 'blocked') return { kind: decision.reason };
    return { kind: 'sent' };
  }

  async function sendLearnReminders(now: Date) {
    for (const due of await store.dueLearnReminders(now)) {
      const { context: ctx, portion } = due;
      if (isPaused(ctx.user, now) || ctx.user.blockedAt) continue;
      if (applyQuietHours(due.dueAt, ctx.user) > now) continue;
      if (!(await store.claimLearnReminder(due.reviewId))) continue;
      const deliveryId = await store.createDelivery({
        userId: ctx.user.userId,
        textId: ctx.text.id,
        portionId: portion.id,
        kind: 'learn_reminder',
        slotAt: due.dueAt,
        dedupeKey: `learn:${due.reviewId}:${due.dueAt.toISOString()}`,
      });
      if (deliveryId === null) continue;
      const count = (await store.countUnits(ctx.text.id, portion.lineStart, portion.lineEnd)) || 1;
      let ok = false;
      try {
        const result = await notifier.sendLearnReminder(ctx.user.userId, {
          ...portionInfo(ctx, portion),
          deliveryId,
          count,
          replaced: false,
        });
        ok = await handleSent(ctx, result, deliveryId, [], now);
        if (!result.ok && result.reason === 'blocked') ok = true;
      } catch (err) {
        reportError(err, { reviewId: due.reviewId });
      }
      if (!ok) {
        await store.deleteDelivery(deliveryId);
        await store.releaseLearnReminder(due.reviewId);
      }
    }
  }

  interface Resolved {
    delivery: DeliveryRecord;
    portion: PortionRecord;
    ctx: PlanContext;
  }

  /** Отправка с кнопками, принадлежащая пользователю и ещё актуальная. */
  async function resolve(userId: bigint, deliveryId: number): Promise<Resolved | null> {
    const delivery = await store.getDelivery(deliveryId);
    if (!delivery || delivery.userId !== userId || delivery.status !== 'sent') return null;
    if (delivery.portionId === null) return null;
    const portion = await store.getPortion(delivery.portionId);
    if (!portion) return null;
    const ctx = await store.planContext(portion.planId);
    return ctx ? { delivery, portion, ctx } : null;
  }

  async function sendExtra(
    r: Resolved,
    from: number,
    to: number,
    marginSteps: number,
    now: Date,
  ): Promise<PortionAction> {
    const boxes = (await store.unitBoxes(r.ctx.text.id, from, to)).filter((box) => !box.skipped);
    const pictures = await images.pictures(r.ctx.text, boxes, marginSteps);
    const result = await notifier.sendPictures(
      r.ctx.user.userId,
      unitLabel(r.ctx),
      toNotifier(pictures),
    );
    if (result.ok) {
      await images.remember(
        r.ctx.text.id,
        pictures.flatMap((picture, index) => {
          const fileId = result.fileIds[index];
          return picture.png && fileId ? [{ cacheKey: picture.cacheKey, fileId }] : [];
        }),
      );
      return { kind: 'context_sent' };
    }
    if (result.reason === 'blocked') await store.setBlocked(r.ctx.user.userId, now);
    else reportError(result.error, { deliveryId: r.delivery.id });
    return { kind: 'failed' };
  }

  /** Непропущенные единицы порции по порядку. */
  async function portionUnits(r: Resolved): Promise<number[]> {
    const rows = await store.unitRows(r.ctx.text.id, r.portion.lineStart, r.portion.lineEnd);
    return rows.filter((row) => !row.skipped).map((row) => row.lineNumber);
  }

  async function skipUnits(r: Resolved, numbers: number[], now: Date): Promise<PortionAction> {
    const { ctx, portion } = r;
    const { plan } = ctx;
    await store.markSkipped(ctx.text.id, numbers);

    // Кнопки прежних отправок порции больше не действуют.
    for (const old of await store.openPortionDeliveries(portion.id)) {
      await store.setDeliveryStatus(old.id, 'replaced', now);
      if (old.buttonsMessageId !== null) {
        await notifier.clearButtons(ctx.user.userId, old.buttonsMessageId).catch(() => undefined);
      }
    }

    const refill = await nextUnits(ctx, portion.lineStart);
    const day = planningDayOf(now, ctx.user);
    if (!refill) {
      await store.deletePortion(portion.id);
      await store.updatePlan(plan.id, { nextLine: plan.lineTo + 1 });
      await finishIfLearned({ ...ctx, plan: { ...plan, nextLine: plan.lineTo + 1 } });
      return {
        kind: 'skipped',
        portion: portionInfo(ctx, portion),
        skipped: numbers,
        replaced: false,
        endDate: null,
      };
    }

    const nextLine = refill.lineEnd + 1;
    const remaining = await store.countUnits(ctx.text.id, nextLine, plan.lineTo);
    const endDate =
      remaining > 0
        ? estimateEndDate(day, remaining, plan.unitsPerDay, plan.restDays, plan.startDate)
        : day;
    await store.updatePortionRange(portion.id, refill.lineStart, refill.lineEnd);
    await store.updatePlan(plan.id, { nextLine, estimatedEndDate: endDate });

    const attempt = await store.countPortionDeliveries(portion.id);
    const deliveryId = await store.createDelivery({
      userId: ctx.user.userId,
      textId: ctx.text.id,
      portionId: portion.id,
      kind: 'portion',
      slotAt: now,
      dedupeKey: `portion:${plan.id}:${portion.seq}:r${attempt}`,
    });
    if (deliveryId === null) return { kind: 'failed' };
    const sent = await sendPortion(ctx, refill, deliveryId, true, now).catch((err: unknown) => {
      reportError(err, { portionId: portion.id });
      return false;
    });
    if (!sent) {
      await store.setDeliveryStatus(deliveryId, 'failed', now);
      return { kind: 'failed' };
    }
    return {
      kind: 'skipped',
      portion: portionInfo(ctx, refill),
      skipped: numbers,
      replaced: true,
      endDate,
    };
  }

  return {
    /** Тик планировщика: новые порции и напоминания про неотмеченные порции. */
    async tick(now: Date): Promise<boolean> {
      const ran = await store.withTickLock(async () => {
        for (const ctx of await store.listActivePlans()) {
          if (ctx.user.blockedAt || isPaused(ctx.user, now)) continue;
          try {
            if ((await decide(ctx, now)).kind === 'now') await issue(ctx, now);
          } catch (err) {
            reportError(err, { planId: ctx.plan.id });
          }
        }
        await sendLearnReminders(now);
        return true;
      });
      return ran !== null;
    },

    /** Когда придёт порция плана — без отправки (для сообщения «План создан»). */
    async preview(planId: number, now: Date): Promise<NextPortion> {
      const ctx = await store.planContext(planId);
      if (!ctx) return { kind: 'done' };
      if (isPaused(ctx.user, now)) return { kind: 'paused' };
      const decision = await decide(ctx, now);
      return decision.kind === 'now' ? { kind: 'sent' } : toNext(decision);
    },

    issueIfDue,

    async learned(userId: bigint, deliveryId: number, now: Date): Promise<PortionAction> {
      const r = await resolve(userId, deliveryId);
      if (!r) return { kind: 'stale' };
      const info = portionInfo(r.ctx, r.portion);
      if (r.portion.status !== 'sent') return { kind: 'already_learned', portion: info };
      const anchor = nearestSlot(now, r.ctx.user);
      const reviews = reviewChain(anchor, now, r.ctx.user);
      if (!(await store.markLearned(r.portion.id, now, anchor.at, reviews))) {
        return { kind: 'already_learned', portion: info };
      }
      // Статус отправки не меняется: кнопки контекста под порцией продолжают работать.
      const next = await issueIfDue(r.ctx.plan.id, now);
      return { kind: 'learned', portion: info, reviews, next };
    },

    async stillLearning(userId: bigint, deliveryId: number): Promise<PortionAction> {
      const r = await resolve(userId, deliveryId);
      if (!r) return { kind: 'stale' };
      const info = portionInfo(r.ctx, r.portion);
      if (r.portion.status !== 'sent') return { kind: 'already_learned', portion: info };
      await store.cancelLearnReminder(r.portion.id);
      return { kind: 'still_learning', portion: info };
    },

    async remindLater(userId: bigint, deliveryId: number, now: Date): Promise<PortionAction> {
      const r = await resolve(userId, deliveryId);
      if (!r) return { kind: 'stale' };
      const info = portionInfo(r.ctx, r.portion);
      if (r.portion.status !== 'sent') return { kind: 'already_learned', portion: info };
      const dueAt = new Date(now.getTime() + L.remindLaterMin * MINUTE);
      await store.rescheduleLearnReminder(r.portion.id, dueAt);
      return { kind: 'remind_later', portion: info, at: applyQuietHours(dueAt, r.ctx.user) };
    },

    /** «Захватить больше»: та же порция с вертикальным запасом. */
    async captureMore(userId: bigint, deliveryId: number, now: Date): Promise<PortionAction> {
      const r = await resolve(userId, deliveryId);
      if (!r || r.delivery.kind !== 'portion') return { kind: 'stale' };
      const steps = r.delivery.cropMarginSteps + 1;
      if (steps > L.maxMarginSteps) {
        return { kind: 'context_limit', direction: 'more', max: L.maxMarginSteps };
      }
      const result = await sendExtra(r, r.portion.lineStart, r.portion.lineEnd, steps, now);
      if (result.kind === 'context_sent') {
        await store.updateDeliveryContext(deliveryId, { cropMarginSteps: steps });
      }
      return result;
    },

    /** «Ещё выше» / «Ещё ниже»: соседняя непропущенная единица. */
    async neighbour(
      userId: bigint,
      deliveryId: number,
      direction: 'up' | 'down',
      now: Date,
    ): Promise<PortionAction> {
      const r = await resolve(userId, deliveryId);
      if (!r || r.delivery.kind !== 'portion') return { kind: 'stale' };
      const count = (direction === 'up' ? r.delivery.extraBefore : r.delivery.extraAfter) + 1;
      if (count > L.maxExtraUnits) {
        return { kind: 'context_limit', direction, max: L.maxExtraUnits };
      }
      const rows =
        direction === 'up'
          ? await store.unitRows(r.ctx.text.id, 1, r.portion.lineStart - 1)
          : await store.unitRows(r.ctx.text.id, r.portion.lineEnd + 1, r.ctx.text.totalLines);
      const candidates = rows.filter((row) => !row.skipped);
      const target = direction === 'up' ? candidates.at(-count) : candidates[count - 1];
      if (!target) return { kind: 'context_edge', direction, unit: unitLabel(r.ctx) };
      const result = await sendExtra(r, target.lineNumber, target.lineNumber, 0, now);
      if (result.kind === 'context_sent') {
        await store.updateDeliveryContext(
          deliveryId,
          direction === 'up' ? { extraBefore: count } : { extraAfter: count },
        );
      }
      return result;
    },

    /** «Пропустить…»: одна единица — сразу, несколько — выбор. */
    async skipMenu(userId: bigint, deliveryId: number, now: Date): Promise<PortionAction> {
      const r = await resolve(userId, deliveryId);
      if (!r || r.delivery.kind !== 'portion') return { kind: 'stale' };
      const info = portionInfo(r.ctx, r.portion);
      if (r.portion.status !== 'sent') return { kind: 'already_learned', portion: info };
      const units = await portionUnits(r);
      if (units.length <= 1) return skipUnits(r, units, now);
      return {
        kind: 'skip_menu',
        deliveryId,
        portion: info,
        units,
        mask: units.length > L.maxSkipChoices ? null : 0n,
      };
    },

    /** Отметить / снять единицу в выборе. */
    async toggleSkip(
      userId: bigint,
      deliveryId: number,
      mask: bigint,
      index: number,
    ): Promise<PortionAction> {
      const r = await resolve(userId, deliveryId);
      if (!r || r.portion.status !== 'sent') return { kind: 'stale' };
      const units = await portionUnits(r);
      if (index < 0 || index >= units.length || units.length > L.maxSkipChoices) {
        return { kind: 'stale' };
      }
      return {
        kind: 'skip_menu',
        deliveryId,
        portion: portionInfo(r.ctx, r.portion),
        units,
        mask: mask ^ (1n << BigInt(index)),
      };
    },

    /** Пропустить выбранные единицы (mask) или всю порцию (null). */
    async skip(
      userId: bigint,
      deliveryId: number,
      mask: bigint | null,
      now: Date,
    ): Promise<PortionAction> {
      const r = await resolve(userId, deliveryId);
      if (!r || r.delivery.kind !== 'portion') return { kind: 'stale' };
      if (r.portion.status !== 'sent') {
        return { kind: 'already_learned', portion: portionInfo(r.ctx, r.portion) };
      }
      const units = await portionUnits(r);
      const chosen =
        mask === null ? units : units.filter((_, index) => (mask >> BigInt(index)) & 1n);
      if (chosen.length === 0) return { kind: 'stale' };
      return skipUnits(r, chosen, now);
    },
  };
}

export type Learning = ReturnType<typeof createLearning>;
