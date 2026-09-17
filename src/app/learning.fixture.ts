import type { LineBox } from '../core/pdf/layout.js';
import type { Images, OutgoingPicture } from './images.js';
import { createLearning } from './learning.js';
import {
  BATCH_KINDS,
  type BatchView,
  type DeliveryRecord,
  type DialogSnapshot,
  type DialogStore,
  type LearnerSettings,
  type LearningStore,
  type Notice,
  type Notifier,
  type PlanContext,
  type PlanRecord,
  type PortionRecord,
  type PortionView,
  type ReviewRow,
  type ReviewStageName,
  type ReviewStatusName,
  type SendResult,
} from './ports.js';
import { createPause } from './pause.js';
import { createReviews } from './reviews.js';
import { createTick } from './tick.js';

// Подделка хранилища и Notifier в памяти для тестов app/learning и app/reviews.

export const USER = 7n;
// 16.09.2026 (ср), основной слот 06:00 МСК = 03:00 UTC.
export const at = (s: string) => new Date(s);
export const MAIN = at('2026-09-16T03:00:00Z');
export const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

export interface FakeReview {
  id: number;
  portionId: number;
  stage: ReviewStageName;
  dueAt: Date;
  status: ReviewStatusName;
  deliveryId?: number | null;
}

export function setup(
  options: { totalLines?: number; unitsPerDay?: number; restDays?: number[] } = {},
) {
  const totalLines = options.totalLines ?? 12;
  const skipped = new Set<number>();
  const user: LearnerSettings = {
    userId: USER,
    timezone: 'Europe/Moscow',
    dailySendTime: '06:00',
    eveningReminderTime: '21:00',
    nightStart: '23:00',
    nightEnd: '07:00',
    nightPolicy: 'keep',
    learnReminderDelayMin: 120,
    pausedFrom: null,
    pausedUntil: null,
    blockedAt: null,
    lastActivityAt: at('2026-09-15T12:00:00Z'),
  };
  const plan: PlanRecord = {
    id: 1,
    textId: 10,
    userId: USER,
    lineFrom: 1,
    lineTo: totalLines,
    unitsPerDay: options.unitsPerDay ?? 3,
    paceMode: 'per_day',
    startDate: '2026-09-16',
    deadlineDate: null,
    deadlineInput: null,
    restDays: options.restDays ?? [],
    status: 'active',
    nextLine: 1,
    estimatedEndDate: '2026-09-19',
  };
  const context = (): PlanContext => ({
    plan: { ...plan },
    user: { ...user },
    text: {
      id: 10,
      title: 'Манзума',
      unitName: 'bayts',
      parseStrategy: 'numbers',
      sourceKind: 'pdf',
      filePath: '/t.pdf',
      totalLines,
    },
  });

  const portions: PortionRecord[] = [];
  const reviews: FakeReview[] = [];
  const deliveries: (DeliveryRecord & { dedupeKey: string })[] = [];
  let id = 100;
  const box = (n: number): LineBox & { skipped: boolean } => ({
    lineNumber: n,
    printedNumber: n,
    page: 1,
    sectionBreakBefore: false,
    skipped: skipped.has(n),
    fragments: [
      { kind: 'text', page: 1, yTop: n * 20, yBottom: n * 20 + 18, xLeft: null, xRight: null },
    ],
  });
  const range = (from: number, to: number) =>
    Array.from({ length: Math.max(0, Math.min(to, totalLines) - Math.max(from, 1) + 1) }, (_, i) =>
      box(Math.max(from, 1) + i),
    );
  const newDelivery = (d: {
    userId: bigint;
    textId: number | null;
    portionId: number | null;
    kind: DeliveryRecord['kind'];
    slotAt: Date;
    dedupeKey: string;
  }) => {
    if (deliveries.some((x) => x.dedupeKey === d.dedupeKey)) return null;
    const row = {
      ...d,
      id: ++id,
      status: 'sending' as const,
      messageIds: [],
      buttonsMessageId: null,
      cropMarginSteps: 0,
      extraBefore: 0,
      extraAfter: 0,
    };
    deliveries.push(row);
    return row.id;
  };
  let locked = false;
  const toRow = (r: FakeReview): ReviewRow => {
    const portion = portions.find((p) => p.id === r.portionId)!;
    return {
      id: r.id,
      portionId: r.portionId,
      dueAt: r.dueAt,
      status: r.status,
      lineStart: portion.lineStart,
      lineEnd: portion.lineEnd,
    };
  };

  const store: LearningStore = {
    withTickLock: async (fn) => {
      if (locked) return null;
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
      }
    },
    listActivePlans: async () => (plan.status === 'active' ? [context()] : []),
    listOpenPlans: async (uid) =>
      (plan.status === 'active' || plan.status === 'learning_done') && (uid ?? USER) === USER
        ? [context()]
        : [],
    planContext: async () => context(),
    textPlanContext: async () => context(),
    learner: async () => ({ ...user }),
    listTimedPauses: async () =>
      user.pausedFrom && user.pausedUntil && !user.blockedAt ? [{ ...user }] : [],
    hasResumeBatchSince: async (_t, since) =>
      deliveries.some(
        (d) =>
          d.dedupeKey.startsWith('batch:10:resume:') &&
          ['sent', 'replaced'].includes(d.status) &&
          d.slotAt >= since,
      ),
    lastPortion: async () => portions.at(-1) ?? null,
    getPortion: async (pid) => portions.find((p) => p.id === pid) ?? null,
    unlearnedPortion: async () => portions.find((p) => p.status === 'sent') ?? null,
    textReviews: async () =>
      reviews
        .filter(
          (r) =>
            r.stage !== 'learn_reminder' &&
            (r.status === 'pending' || r.status === 'sent' || r.status === 'missed'),
        )
        .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id - b.id)
        .map(toRow),
    deliveryReviews: async (did) =>
      reviews.filter((r) => r.stage !== 'learn_reminder' && r.deliveryId === did).map(toRow),
    attachReviews: async (did, ids) => {
      for (const r of reviews) {
        if (ids.includes(r.id) && ['pending', 'sent', 'missed'].includes(r.status)) {
          Object.assign(r, { status: 'sent', deliveryId: did });
        }
      }
    },
    answerReviews: async (did, answer) => {
      const from = answer === 'confirmed' ? ['sent', 'missed'] : ['sent'];
      const changed = reviews.filter(
        (r) => r.deliveryId === did && r.stage !== 'learn_reminder' && from.includes(r.status),
      );
      for (const r of changed) r.status = answer;
      return changed.length;
    },
    completePortions: async () => {
      for (const p of portions) {
        const done = reviews.some(
          (r) => r.portionId === p.id && r.stage === 'rep_1m' && r.status === 'confirmed',
        );
        if (p.status === 'learned' && done) p.status = 'completed';
      }
      if (plan.status !== 'learning_done' || portions.some((p) => p.status !== 'completed')) {
        return false;
      }
      plan.status = 'completed';
      return true;
    },
    openBatchDeliveries: async () =>
      deliveries.filter(
        (d) => (BATCH_KINDS as readonly string[]).includes(d.kind) && d.status === 'sent',
      ),
    unitRows: async (_t, from, to) =>
      range(from, to).map(({ lineNumber, skipped: s }) => ({ lineNumber, skipped: s })),
    unitBoxes: async (_t, from, to) => range(from, to),
    createPortion: async (p) => {
      if (plan.nextLine !== p.expectedNextLine || portions.some((x) => x.seq === p.seq)) {
        return null;
      }
      const portion: PortionRecord = {
        id: ++id,
        planId: p.planId,
        seq: p.seq,
        lineStart: p.lineStart,
        lineEnd: p.lineEnd,
        status: 'sent',
        sentAt: p.sentAt,
        learnedAt: null,
        anchorAt: null,
      };
      portions.push(portion);
      plan.nextLine = p.nextLine;
      reviews.push({
        id: ++id,
        portionId: portion.id,
        stage: 'learn_reminder',
        dueAt: p.learnReminderAt,
        status: 'pending',
      });
      const deliveryId = newDelivery({ ...p.delivery, portionId: portion.id, kind: 'portion' })!;
      return { portion: { ...portion }, deliveryId };
    },
    rollbackPortion: async (pid, nextLine) => {
      // В БД отправки и повторы порции удаляет каскад.
      for (let i = deliveries.length - 1; i >= 0; i--) {
        if (deliveries[i]!.portionId === pid) deliveries.splice(i, 1);
      }
      portions.splice(
        portions.findIndex((p) => p.id === pid),
        1,
      );
      plan.nextLine = nextLine;
    },
    createDelivery: async (d) => newDelivery(d),
    markDeliverySent: async (did, messageIds, buttonsMessageId) => {
      Object.assign(
        deliveries.find((d) => d.id === did)!,
        {
          status: 'sent',
          messageIds,
          buttonsMessageId,
        },
      );
    },
    setDeliveryStatus: async (did, status) => {
      deliveries.find((d) => d.id === did)!.status = status;
    },
    deleteDelivery: async (did) => {
      deliveries.splice(
        deliveries.findIndex((d) => d.id === did),
        1,
      );
    },
    getDelivery: async (did) => {
      const d = deliveries.find((x) => x.id === did);
      return d ? { ...d } : null;
    },
    updateDeliveryContext: async (did, patch) => {
      Object.assign(
        deliveries.find((d) => d.id === did)!,
        patch,
      );
    },
    openPortionDeliveries: async (pid) =>
      deliveries.filter(
        (d) =>
          d.portionId === pid &&
          d.status === 'sent' &&
          (d.kind === 'portion' || d.kind === 'learn_reminder'),
      ),
    countPortionDeliveries: async (pid) => deliveries.filter((d) => d.portionId === pid).length,
    markLearned: async (pid, learnedAt, anchorAt, chain) => {
      const portion = portions.find((p) => p.id === pid)!;
      if (portion.status !== 'sent') return false;
      Object.assign(portion, { status: 'learned', learnedAt, anchorAt });
      for (const r of reviews) {
        if (r.portionId === pid && r.stage === 'learn_reminder' && r.status === 'pending') {
          r.status = 'cancelled';
        }
      }
      for (const c of chain) {
        reviews.push({ id: ++id, portionId: pid, ...c, status: 'pending' });
      }
      return true;
    },
    cancelLearnReminder: async (pid) => {
      for (const r of reviews) {
        if (r.portionId === pid && r.stage === 'learn_reminder' && r.status === 'pending') {
          r.status = 'cancelled';
        }
      }
    },
    rescheduleLearnReminder: async (pid, dueAt) => {
      const r = reviews.find((x) => x.portionId === pid && x.stage === 'learn_reminder')!;
      Object.assign(r, { dueAt, status: 'pending' });
    },
    dueLearnReminders: async (now) =>
      reviews
        .filter((r) => r.stage === 'learn_reminder' && r.status === 'pending' && r.dueAt <= now)
        .map((r) => ({
          reviewId: r.id,
          dueAt: r.dueAt,
          portion: portions.find((p) => p.id === r.portionId)!,
          context: context(),
        }))
        .filter((r) => r.portion.status === 'sent'),
    claimLearnReminder: async (rid) => {
      const r = reviews.find((x) => x.id === rid)!;
      if (r.status !== 'pending') return false;
      r.status = 'sent';
      return true;
    },
    releaseLearnReminder: async (rid) => {
      reviews.find((x) => x.id === rid)!.status = 'pending';
    },
    markSkipped: async (_t, numbers) => numbers.forEach((n) => skipped.add(n)),
    updatePortionRange: async (pid, lineStart, lineEnd) => {
      Object.assign(
        portions.find((p) => p.id === pid)!,
        { lineStart, lineEnd },
      );
    },
    deletePortion: async (pid) => {
      portions.splice(
        portions.findIndex((p) => p.id === pid),
        1,
      );
    },
    updatePlan: async (_pid, patch) => void Object.assign(plan, patch),
    countUnits: async (_t, from, to) => range(from, to).filter((b) => !b.skipped).length,
    setBlocked: async (_u, when) => {
      user.blockedAt = when;
    },
    resetActivity: async (_u, when) => {
      user.lastActivityAt = when;
    },
    setPause: async (_u, from, until) => {
      user.pausedFrom = from;
      user.pausedUntil = from && until;
    },
  };

  const sent: {
    kind: string;
    view?: PortionView;
    batch?: BatchView;
    notice?: Notice;
    lines?: [number, number][];
  }[] = [];
  const cleared: number[] = [];
  const deleted: number[] = [];
  let failNext: SendResult | null = null;
  let messageId = 1000;
  const result = (count: number): SendResult => {
    if (failNext) {
      const r = failNext;
      failNext = null;
      return r;
    }
    return {
      ok: true,
      messageIds: [++messageId],
      buttonsMessageId: messageId,
      fileIds: Array.from({ length: count }, (_, i) => `file${messageId}-${i}`),
    };
  };
  const notifier: Notifier = {
    sendPortion: async (_u, view, pictures) => {
      const r = result(pictures.length);
      if (r.ok)
        sent.push({ kind: 'portion', view, lines: pictures.map((p) => [p.lineStart, p.lineEnd]) });
      return r;
    },
    sendLearnReminder: async (_u, view) => {
      const r = result(0);
      if (r.ok) sent.push({ kind: 'reminder', view });
      return r;
    },
    sendPictures: async (_u, _unit, pictures) => {
      const r = result(pictures.length);
      if (r.ok)
        sent.push({ kind: 'pictures', lines: pictures.map((p) => [p.lineStart, p.lineEnd]) });
      return r;
    },
    sendBatch: async (_u, batch, pictures) => {
      const r = result(pictures.length);
      if (r.ok)
        sent.push({ kind: 'batch', batch, lines: pictures.map((p) => [p.lineStart, p.lineEnd]) });
      return r;
    },
    sendText: async () => result(0),
    sendNotice: async (_u, notice) => {
      const r = result(0);
      if (r.ok) sent.push({ kind: notice.kind, notice });
      return r;
    },
    clearButtons: async (_u, mid) => void cleared.push(mid),
    deleteMessages: async (_u, ids) => {
      deleted.push(...ids);
      return true;
    },
  };

  const margins: number[] = [];
  const remembered: string[] = [];
  const images = {
    render: async () => [],
    pictures: async (_text: unknown, boxes: readonly LineBox[], marginSteps = 0) => {
      margins.push(marginSteps);
      const pictures: OutgoingPicture[] = [];
      for (const b of boxes) {
        const last = pictures.at(-1);
        if (last && last.lineEnd + 1 === b.lineNumber) last.lineEnd = b.lineNumber;
        else {
          pictures.push({
            page: 1,
            lineStart: b.lineNumber,
            lineEnd: b.lineNumber,
            cacheKey: `k${b.lineNumber}:${marginSteps}`,
            fileId: null,
            png: Buffer.from('png'),
          });
        }
      }
      return pictures;
    },
    remember: async (_t: number, entries: { fileId: string }[]) => {
      remembered.push(...entries.map((e) => e.fileId));
    },
  } as unknown as Images;

  const errors: unknown[] = [];
  const reportError = (err: unknown) => void errors.push(err);
  const learning = createLearning({ store, notifier, images, reportError });
  const reviewsApp = createReviews({ store, notifier, images, learning, reportError });
  const dialogState = new Map<bigint, DialogSnapshot>();
  const dialogs: DialogStore = {
    get: async (uid) => dialogState.get(uid) ?? null,
    set: async (uid, dialog) => void dialogState.set(uid, dialog),
    clear: async (uid) => void dialogState.delete(uid),
  };
  const pause = createPause({
    store,
    notifier,
    images,
    learning,
    reviews: reviewsApp,
    dialogs,
    reportError,
  });
  const tick = createTick({
    withLock: store.withTickLock,
    steps: [
      { name: 'pause', run: pause.runDue },
      { name: 'reviews', run: reviewsApp.runDue },
      { name: 'portions', run: learning.runDue },
    ],
    reportError,
  });
  const lastPortionDelivery = () => deliveries.filter((d) => d.kind === 'portion').at(-1)!;
  return {
    store,
    notifier,
    images,
    learning,
    reviewsApp,
    pause,
    dialogs,
    tick,
    plan,
    user,
    portions,
    reviews,
    deliveries,
    sent,
    cleared,
    deleted,
    margins,
    remembered,
    errors,
    skipped,
    lastPortionDelivery,
    fail: (r: SendResult) => {
      failNext = r;
    },
  };
}
