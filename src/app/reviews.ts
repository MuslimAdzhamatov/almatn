import {
  batchContent,
  batchDedupeKey,
  debtSince,
  immediateEvent,
  isQuietDebt,
  latestEvent,
  type SlotEvent,
} from '../core/scheduler/batch.js';
import type { Images } from './images.js';
import {
  isPaused,
  portionInfo,
  unitLabel,
  type Learning,
  type NextPortion,
  type PortionAction,
  type PortionInfo,
} from './learning.js';
import {
  BATCH_KINDS,
  type BatchButtons,
  type BatchKind,
  type BatchView,
  type DeliveryRecord,
  type LearningStore,
  type Notifier,
  type PlanContext,
  type PortionRecord,
  type ReviewRow,
  type UnitLabel,
} from './ports.js';
import { settleSend, toNotifier } from './sending.js';
import { boxesIn, mergedRanges } from './units.js';

// Сводные повторы и напоминания о долге (CLAUDE.md, разделы 5.1 и 5.2): одно сообщение на текст
// в слот, ответы «Повторил(а)» / «Не успел(а)» / «Выучил …». Кнопки контекста — в app/learning.ts.

export interface ReviewsDeps {
  store: LearningStore;
  notifier: Notifier;
  images: Images;
  learning: Learning;
  reportError?: (err: unknown, context: Record<string, unknown>) => void;
}

/** Что показать под сводкой после ответа. */
export interface BatchState extends UnitLabel {
  deliveryId: number;
  title: string;
  timezone: string;
  kind: BatchKind;
  buttons: BatchButtons;
}

export type BatchAction =
  | {
      kind: 'answered';
      answer: 'confirmed' | 'missed';
      state: BatchState;
      next: NextPortion | null;
      /** Все порции плана прошли повтор через месяц — план закрыт. */
      planCompleted: boolean;
    }
  | { kind: 'learned'; action: Extract<PortionAction, { kind: 'learned' }>; state: BatchState }
  /** Отвечать уже не на что: повторы отмечены раньше или порция уже выучена. */
  | { kind: 'unchanged'; state: BatchState; portion: PortionInfo | null }
  | { kind: 'stale' };

const isBatch = (delivery: DeliveryRecord) =>
  (BATCH_KINDS as readonly string[]).includes(delivery.kind);

function batchKind(
  event: SlotEvent,
  reviews: readonly ReviewRow[],
  portion: PortionRecord | null,
): BatchKind {
  if (event.kind === 'evening') return 'evening';
  // В основной слот всё, что уже приходило раньше или не выучено, — напоминание о долге.
  if (portion || reviews.some((r) => r.status !== 'pending')) return 'debt';
  return 'review';
}

export function createReviews({
  store,
  notifier,
  images,
  learning,
  reportError = () => undefined,
}: ReviewsDeps) {
  const sending = { store, images, reportError };

  async function stateOf(ctx: PlanContext, delivery: DeliveryRecord): Promise<BatchState> {
    const reviews = await store.deliveryReviews(delivery.id);
    const portion = delivery.portionId === null ? null : await store.getPortion(delivery.portionId);
    return {
      ...unitLabel(ctx),
      deliveryId: delivery.id,
      title: ctx.text.title,
      timezone: ctx.user.timezone,
      kind: delivery.kind === 'debt_reminder' ? 'evening' : portion ? 'debt' : 'review',
      buttons: {
        confirm: reviews.some((r) => r.status === 'sent'),
        learn:
          portion?.status === 'sent'
            ? { lineStart: portion.lineStart, lineEnd: portion.lineEnd }
            : null,
      },
    };
  }

  /** Прежние сводки текста теряют кнопки: новое сообщение содержит весь долг. */
  async function replaceOlder(ctx: PlanContext, keepId: number, now: Date) {
    for (const old of await store.openBatchDeliveries(ctx.text.id)) {
      if (old.id === keepId) continue;
      await store.setDeliveryStatus(old.id, 'replaced', now);
      if (old.buttonsMessageId !== null) {
        await notifier.clearButtons(ctx.user.userId, old.buttonsMessageId).catch(() => undefined);
      }
    }
  }

  async function dispatchText(
    ctx: PlanContext,
    now: Date,
    event: SlotEvent,
    dedupeKey: string,
  ): Promise<boolean> {
    const { user, text, plan } = ctx;
    const owed = await store.textReviews(text.id);
    const unlearned = plan.status === 'active' ? await store.unlearnedPortion(plan.id) : null;
    // Долг тянется 3 плановых суток — только сообщение основного слота.
    if (event.kind !== 'main' && isQuietDebt(debtSince(now, owed, unlearned), now, user)) {
      return false;
    }
    const content = batchContent({ now, event, reviews: owed, unlearned });
    if (!content) return false;

    const deliveryId = await store.createDelivery({
      userId: user.userId,
      textId: text.id,
      portionId: content.portionId,
      kind: event.kind === 'evening' ? 'debt_reminder' : 'review_batch',
      slotAt: event.at,
      dedupeKey,
    });
    if (deliveryId === null) return false;

    let ok = false;
    try {
      const included = owed.filter((r) => content.reviewIds.includes(r.id));
      const portion = content.portionId === null ? null : unlearned;
      const units = await deliveryUnitsFor(text.id, included, portion);
      if (units.all.length === 0) {
        await store.deleteDelivery(deliveryId);
        return false;
      }
      const pictures = await images.pictures(text, await boxesIn(store, text.id, units.all));
      const view: BatchView = {
        ...unitLabel(ctx),
        deliveryId,
        title: text.title,
        kind: batchKind(event, included, portion),
        reviews: units.reviews,
        portion: portion && { lineStart: portion.lineStart, lineEnd: portion.lineEnd },
        buttons: {
          confirm: included.length > 0,
          learn: portion && { lineStart: portion.lineStart, lineEnd: portion.lineEnd },
        },
      };
      const result = await notifier.sendBatch(user.userId, view, toNotifier(pictures));
      const target = { userId: user.userId, textId: text.id, deliveryId };
      ok = await settleSend(sending, target, result, pictures, now);
      if (ok) {
        await store.attachReviews(deliveryId, content.reviewIds, now);
        if (event.kind !== 'second') await replaceOlder(ctx, deliveryId, now);
      }
    } catch (err) {
      reportError(err, { textId: text.id, event: event.kind });
    }
    if (!ok) await store.deleteDelivery(deliveryId);
    return ok;
  }

  async function deliveryUnitsFor(
    textId: number,
    reviews: readonly ReviewRow[],
    portion: PortionRecord | null,
  ) {
    const own = portion ? [portion] : [];
    return {
      reviews: await mergedRanges(store, textId, reviews),
      all: await mergedRanges(store, textId, [...reviews, ...own]),
    };
  }

  /** Сводка пользователя, на которую ещё можно ответить. */
  async function resolve(userId: bigint, deliveryId: number) {
    const delivery = await store.getDelivery(deliveryId);
    if (!delivery || delivery.userId !== userId || delivery.status !== 'sent') return null;
    if (!isBatch(delivery) || delivery.textId === null) return null;
    const ctx = await store.textPlanContext(delivery.textId);
    return ctx ? { delivery, ctx } : null;
  }

  return {
    /** Шаг тика (app/tick.ts): сводки по всем открытым планам за последнее наступившее событие. */
    async runDue(now: Date): Promise<void> {
      for (const ctx of await store.listOpenPlans()) {
        if (ctx.user.blockedAt || isPaused(ctx.user, now)) continue;
        try {
          const event = latestEvent(now, ctx.user);
          await dispatchText(ctx, now, event, batchDedupeKey(ctx.text.id, event));
        } catch (err) {
          reportError(err, { planId: ctx.plan.id });
        }
      }
    },

    /**
     * Сводка всего долга сейчас — после окончания паузы. Возвращает, сколько сообщений отправлено.
     */
    async sendDebtNow(userId: bigint, now: Date): Promise<number> {
      let sent = 0;
      for (const ctx of await store.listOpenPlans()) {
        if (ctx.user.userId !== userId) continue;
        const event = immediateEvent(now, ctx.user);
        const key = `batch:${ctx.text.id}:resume:${now.toISOString()}`;
        if (await dispatchText(ctx, now, event, key)) sent += 1;
      }
      return sent;
    },

    /** «Повторил(а)» / «Не успел(а)»: ответ на все ещё не отмеченные повторы этой сводки. */
    async answer(
      userId: bigint,
      deliveryId: number,
      answer: 'confirmed' | 'missed',
      now: Date,
    ): Promise<BatchAction> {
      const r = await resolve(userId, deliveryId);
      if (!r) return { kind: 'stale' };
      const changed = await store.answerReviews(deliveryId, answer, now);
      const state = await stateOf(r.ctx, r.delivery);
      if (changed === 0) return { kind: 'unchanged', state, portion: null };
      if (answer === 'missed') {
        return { kind: 'answered', answer, state, next: null, planCompleted: false };
      }
      // После повтора через месяц порция закрыта; закрыты все — закрыт и план.
      const planCompleted = await store.completePortions(r.ctx.plan.id, now);
      const issued = planCompleted ? null : await learning.issueIfDue(r.ctx.plan.id, now);
      const next = issued?.kind === 'done' ? null : issued;
      return { kind: 'answered', answer, state, next, planCompleted };
    },

    /** «Выучил …» под напоминанием о долге — тот же сценарий, что под порцией. */
    async learned(userId: bigint, deliveryId: number, now: Date): Promise<BatchAction> {
      const r = await resolve(userId, deliveryId);
      if (!r || r.delivery.portionId === null) return { kind: 'stale' };
      const action = await learning.learned(userId, deliveryId, now);
      if (action.kind === 'stale') return { kind: 'stale' };
      const state = await stateOf(r.ctx, r.delivery);
      if (action.kind === 'learned') return { kind: 'learned', action, state };
      const portion = await store.getPortion(r.delivery.portionId);
      return { kind: 'unchanged', state, portion: portion && portionInfo(r.ctx, portion) };
    },
  };
}

export type Reviews = ReturnType<typeof createReviews>;
