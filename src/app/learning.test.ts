import { describe, expect, it } from 'vitest';
import type { LineBox } from '../core/pdf/layout.js';
import type { Images, OutgoingPicture } from './images.js';
import { createLearning, type PortionAction } from './learning.js';
import type {
  DeliveryRecord,
  LearnerSettings,
  LearningStore,
  Notifier,
  PlanContext,
  PlanRecord,
  PortionRecord,
  PortionView,
  ReviewStageName,
  ReviewStatusName,
  SendResult,
} from './ports.js';

const USER = 7n;
// 16.09.2026 (ср), основной слот 06:00 МСК = 03:00 UTC.
const at = (s: string) => new Date(s);
const MAIN = at('2026-09-16T03:00:00Z');
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

interface ReviewRow {
  id: number;
  portionId: number;
  stage: ReviewStageName;
  dueAt: Date;
  status: ReviewStatusName;
}

function setup(options: { totalLines?: number; unitsPerDay?: number; restDays?: number[] } = {}) {
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
  const reviews: ReviewRow[] = [];
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
    planContext: async () => context(),
    lastPortion: async () => portions.at(-1) ?? null,
    getPortion: async (pid) => portions.find((p) => p.id === pid) ?? null,
    unlearnedPortion: async () => portions.find((p) => p.status === 'sent') ?? null,
    textReviews: async () => reviews.filter((r) => r.stage !== 'learn_reminder'),
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
      deliveries.filter((d) => d.portionId === pid && d.status === 'sent'),
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
  };

  const sent: { kind: string; view?: PortionView; lines?: [number, number][] }[] = [];
  const cleared: number[] = [];
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
    sendText: async () => result(0),
    clearButtons: async (_u, mid) => void cleared.push(mid),
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
  const learning = createLearning({
    store,
    notifier,
    images,
    reportError: (err) => void errors.push(err),
  });
  const lastPortionDelivery = () => deliveries.filter((d) => d.kind === 'portion').at(-1)!;
  return {
    learning,
    plan,
    user,
    portions,
    reviews,
    deliveries,
    sent,
    cleared,
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

function expectKind<K extends PortionAction['kind']>(action: PortionAction, kind: K) {
  expect(action.kind).toBe(kind);
  return action as Extract<PortionAction, { kind: K }>;
}

describe('выдача порций', () => {
  it('в основной слот — первая порция с напоминанием через 2 часа', async () => {
    const t = setup();
    expect(await t.learning.tick(MAIN)).toBe(true);
    expect(t.portions).toMatchObject([{ seq: 1, lineStart: 1, lineEnd: 3, status: 'sent' }]);
    expect(t.plan.nextLine).toBe(4);
    expect(t.sent).toMatchObject([
      { kind: 'portion', view: { lineStart: 1, lineEnd: 3, count: 3 } },
    ]);
    expect(t.reviews).toMatchObject([
      { stage: 'learn_reminder', dueAt: minutes(MAIN, 120), status: 'pending' },
    ]);
    expect(t.lastPortionDelivery()).toMatchObject({
      status: 'sent',
      dedupeKey: 'portion:1:1',
      buttonsMessageId: 1001,
    });
    expect(t.remembered).toEqual(['file1001-0']);
    // Второй тик в те же сутки ничего не шлёт.
    await t.learning.tick(minutes(MAIN, 1));
    expect(t.portions).toHaveLength(1);
  });

  it('невыученная порция — долг, новая не приходит; после «Выучил» — в следующий слот', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    const nextDay = at('2026-09-17T03:00:00Z');
    await t.learning.tick(nextDay);
    expect(t.portions).toHaveLength(1);

    // «Выучил» на следующий день утром: долга нет, в эти сутки порции не было — сразу.
    const learned = expectKind(
      await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(nextDay, 30)),
      'learned',
    );
    expect(learned.next).toEqual({ kind: 'sent' });
    expect(t.portions.map((p) => [p.seq, p.lineStart, p.lineEnd])).toEqual([
      [1, 1, 3],
      [2, 4, 6],
    ]);
    // Цепочка от ближайшего слота (06:00 17.09).
    expect(learned.reviews.map((r) => r.dueAt.toISOString())).toEqual([
      '2026-09-17T15:00:00.000Z',
      '2026-09-18T03:00:00.000Z',
      '2026-09-20T03:00:00.000Z',
      '2026-10-01T03:00:00.000Z',
      '2026-10-17T03:00:00.000Z',
    ]);
    // Напоминание уже пришло (прошло больше 2 часов) — оно остаётся отправленным.
    expect(t.reviews.find((r) => r.stage === 'learn_reminder')?.status).toBe('sent');
  });

  it('«Выучил» в тот же день — следующая порция завтра в основной слот', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    const learned = expectKind(
      await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 60)),
      'learned',
    );
    expect(learned.next).toEqual({ kind: 'at', at: at('2026-09-17T03:00:00Z') });
    // Повторное нажатие ничего не ломает.
    expectKind(
      await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 61)),
      'already_learned',
    );
  });

  it('наступивший неподтверждённый повтор блокирует новую порцию', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 5));
    // 17.09 06:00: повтор +12 ч (16.09 18:00) не подтверждён.
    await t.learning.tick(at('2026-09-17T03:00:00Z'));
    expect(t.portions).toHaveLength(1);
    t.reviews.filter((r) => r.stage === 'rep_12h').forEach((r) => (r.status = 'confirmed'));
    // В тот же слот наступил и повтор +1 сутки — тоже долг.
    await t.learning.tick(at('2026-09-17T03:01:00Z'));
    expect(t.portions).toHaveLength(1);
    t.reviews.filter((r) => r.stage === 'rep_1d').forEach((r) => (r.status = 'confirmed'));
    await t.learning.tick(at('2026-09-17T03:02:00Z'));
    expect(t.portions).toHaveLength(2);
  });

  it('последняя порция короче; после неё план — learning_done', async () => {
    const t = setup({ totalLines: 4 });
    await t.learning.tick(MAIN);
    await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 5));
    for (const r of t.reviews) r.status = 'confirmed';
    const day2 = at('2026-09-17T03:00:00Z');
    await t.learning.tick(day2);
    expect(t.portions.at(-1)).toMatchObject({ lineStart: 4, lineEnd: 4 });
    expect(t.plan.status).toBe('active');
    const learned = expectKind(
      await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(day2, 5)),
      'learned',
    );
    expect(learned.next).toEqual({ kind: 'done' });
    expect(t.plan.status).toBe('learning_done');
  });

  it('выходной, пауза и заблокированный бот', async () => {
    const rest = setup({ restDays: [3] });
    await rest.learning.tick(MAIN);
    expect(rest.portions).toHaveLength(0);

    const paused = setup();
    paused.user.pausedFrom = at('2026-09-15T00:00:00Z');
    await paused.learning.tick(MAIN);
    expect(paused.portions).toHaveLength(0);
    expect(await paused.learning.preview(1, MAIN)).toEqual({ kind: 'paused' });

    const blocked = setup();
    blocked.fail({ ok: false, reason: 'blocked', error: new Error('403') });
    await blocked.learning.tick(MAIN);
    expect(blocked.portions).toHaveLength(0);
    expect(blocked.plan.nextLine).toBe(1);
    expect(blocked.user.blockedAt).toEqual(MAIN);
    await blocked.learning.tick(minutes(MAIN, 1));
    expect(blocked.portions).toHaveLength(0);
  });

  it('ошибка отправки — порция откатывается и уходит следующим тиком', async () => {
    const t = setup();
    t.fail({ ok: false, reason: 'error', error: new Error('500') });
    await t.learning.tick(MAIN);
    expect(t.portions).toHaveLength(0);
    expect(t.plan.nextLine).toBe(1);
    expect(t.errors).toHaveLength(1);
    await t.learning.tick(minutes(MAIN, 1));
    expect(t.portions).toHaveLength(1);
  });

  it('догон: бот был выключен в слот — порция приходит при запуске до порога', async () => {
    const t = setup();
    expect(await t.learning.preview(1, at('2026-09-16T02:00:00Z'))).toEqual({
      kind: 'at',
      at: MAIN,
    });
    await t.learning.tick(at('2026-09-16T09:00:00Z'));
    expect(t.portions).toHaveLength(1);
  });

  it('одновременный тик пропускается', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.learning.tick(MAIN), t.learning.tick(MAIN)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(t.portions).toHaveLength(1);
  });
});

describe('напоминание про неотмеченную порцию', () => {
  it('одно напоминание через 2 часа', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    await t.learning.tick(minutes(MAIN, 119));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(0);
    await t.learning.tick(minutes(MAIN, 120));
    await t.learning.tick(minutes(MAIN, 121));
    const reminders = t.sent.filter((s) => s.kind === 'reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.view).toMatchObject({ lineStart: 1, lineEnd: 3, count: 3 });
    // Кнопки напоминания тоже отмечают порцию.
    const reminder = t.deliveries.find((d) => d.kind === 'learn_reminder')!;
    expectKind(await t.learning.learned(USER, reminder.id, minutes(MAIN, 130)), 'learned');
  });

  it('«Ещё учу» отменяет, «Напомнить позже» — через час', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    const id = t.lastPortionDelivery().id;
    expectKind(await t.learning.stillLearning(USER, id), 'still_learning');
    await t.learning.tick(minutes(MAIN, 130));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(0);

    const later = expectKind(
      await t.learning.remindLater(USER, id, minutes(MAIN, 130)),
      'remind_later',
    );
    expect(later.at).toEqual(minutes(MAIN, 190));
    await t.learning.tick(minutes(MAIN, 190));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(1);
  });

  it('ночное напоминание при политике move ждёт утра', async () => {
    const t = setup();
    t.user.nightPolicy = 'move';
    await t.learning.tick(MAIN);
    const id = t.lastPortionDelivery().id;
    // «Напомнить позже» в 22:30 МСК → 23:30, это ночь → 07:00.
    const late = at('2026-09-16T19:30:00Z');
    const later = expectKind(await t.learning.remindLater(USER, id, late), 'remind_later');
    expect(later.at).toEqual(at('2026-09-17T04:00:00Z'));
    await t.learning.tick(minutes(late, 60));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(0);
  });
});

describe('кнопки контекста', () => {
  it('«Захватить больше» — до трёх раз с растущим запасом', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    const id = t.lastPortionDelivery().id;
    for (let i = 0; i < 3; i++) {
      expectKind(await t.learning.captureMore(USER, id, MAIN), 'context_sent');
    }
    expect(t.margins.slice(1)).toEqual([1, 2, 3]);
    expectKind(await t.learning.captureMore(USER, id, MAIN), 'context_limit');
  });

  it('«Ещё выше» / «Ещё ниже» — соседние непропущенные единицы, край текста', async () => {
    const t = setup({ totalLines: 8 });
    t.plan.nextLine = 4;
    t.skipped.add(7);
    await t.learning.tick(MAIN);
    const id = t.lastPortionDelivery().id; // 4–6
    await t.learning.neighbour(USER, id, 'up', MAIN);
    await t.learning.neighbour(USER, id, 'down', MAIN);
    await t.learning.neighbour(USER, id, 'up', MAIN);
    expect(t.sent.filter((s) => s.kind === 'pictures').map((s) => s.lines)).toEqual([
      [[3, 3]],
      [[8, 8]],
      [[2, 2]],
    ]);
    expectKind(await t.learning.neighbour(USER, id, 'down', MAIN), 'context_edge');
    await t.learning.neighbour(USER, id, 'up', MAIN);
    expectKind(await t.learning.neighbour(USER, id, 'up', MAIN), 'context_edge');
    // После «Выучил» кнопки контекста продолжают работать.
    await t.learning.learned(USER, id, minutes(MAIN, 5));
    expectKind(await t.learning.captureMore(USER, id, MAIN), 'context_sent');
  });

  it('чужая отправка — неактуальна', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    expectKind(await t.learning.captureMore(99n, t.lastPortionDelivery().id, MAIN), 'stale');
    expectKind(await t.learning.learned(USER, 12345, MAIN), 'stale');
  });
});

describe('пропуск единиц', () => {
  it('выбор, замена порции и новая дата окончания', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    const first = t.lastPortionDelivery();
    const menu = expectKind(await t.learning.skipMenu(USER, first.id, MAIN), 'skip_menu');
    expect(menu).toMatchObject({ units: [1, 2, 3], mask: 0n });
    const toggled = expectKind(await t.learning.toggleSkip(USER, first.id, 0n, 0), 'skip_menu');
    expect(toggled.mask).toBe(1n);
    const skipped = expectKind(await t.learning.skip(USER, first.id, 1n, MAIN), 'skipped');
    expect(skipped).toMatchObject({ skipped: [1], replaced: true, endDate: '2026-09-19' });
    expect(skipped.portion).toMatchObject({ lineStart: 2, lineEnd: 4 });
    expect(t.portions).toMatchObject([{ seq: 1, lineStart: 2, lineEnd: 4 }]);
    expect(t.plan).toMatchObject({ nextLine: 5, estimatedEndDate: '2026-09-19' });
    // Старая отправка неактуальна, её кнопки убраны; новая пришла с пометкой замены.
    expect(t.deliveries.find((d) => d.id === first.id)?.status).toBe('replaced');
    expect(t.cleared).toEqual([first.buttonsMessageId]);
    expect(t.sent.at(-1)).toMatchObject({ kind: 'portion', view: { replaced: true, count: 3 } });
    expectKind(await t.learning.learned(USER, first.id, MAIN), 'stale');
    expectKind(await t.learning.learned(USER, t.lastPortionDelivery().id, MAIN), 'learned');
  });

  it('пропуск из середины: пропущенная единица не показывается', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    const id = t.lastPortionDelivery().id;
    expectKind(await t.learning.skip(USER, id, 2n, MAIN), 'skipped'); // единица 2
    expect(t.portions[0]).toMatchObject({ lineStart: 1, lineEnd: 4 });
    expect(t.sent.at(-1)?.lines).toEqual([
      [1, 1],
      [3, 4],
    ]);
  });

  it('одна единица в порции — пропускается сразу; «вся порция»', async () => {
    const t = setup({ unitsPerDay: 1, totalLines: 3 });
    await t.learning.tick(MAIN);
    const one = expectKind(
      await t.learning.skipMenu(USER, t.lastPortionDelivery().id, MAIN),
      'skipped',
    );
    expect(one.portion).toMatchObject({ lineStart: 2, lineEnd: 2 });

    const all = setup();
    await all.learning.tick(MAIN);
    const r = expectKind(
      await all.learning.skip(USER, all.lastPortionDelivery().id, null, MAIN),
      'skipped',
    );
    expect(r.skipped).toEqual([1, 2, 3]);
    expect(r.portion).toMatchObject({ lineStart: 4, lineEnd: 6 });
  });

  it('учить больше нечего — порция удаляется, план закончен', async () => {
    const t = setup({ totalLines: 2 });
    await t.learning.tick(MAIN);
    const r = expectKind(
      await t.learning.skip(USER, t.lastPortionDelivery().id, null, MAIN),
      'skipped',
    );
    expect(r).toMatchObject({ replaced: false, endDate: null });
    expect(t.portions).toHaveLength(0);
    expect(t.plan.status).toBe('learning_done');
  });

  it('выученную порцию пропустить нельзя', async () => {
    const t = setup();
    await t.learning.tick(MAIN);
    const id = t.lastPortionDelivery().id;
    await t.learning.learned(USER, id, MAIN);
    expectKind(await t.learning.skipMenu(USER, id, MAIN), 'already_learned');
    expectKind(await t.learning.skip(USER, id, null, MAIN), 'already_learned');
  });
});
