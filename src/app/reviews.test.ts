import { describe, expect, it } from 'vitest';
import { at, MAIN, minutes, setup, USER } from './learning.fixture.js';
import type { BatchAction } from './reviews.js';

// 16.09.2026, МСК: основной слот 06:00 (03:00 UTC), второй — 18:00 (15:00 UTC), вечер — 21:00 (18:00 UTC).
const SECOND = at('2026-09-16T15:00:00Z');
const EVENING = at('2026-09-16T18:00:00Z');
const MAIN_17 = at('2026-09-17T03:00:00Z');

function expectKind<K extends BatchAction['kind']>(action: BatchAction, kind: K) {
  expect(action.kind).toBe(kind);
  return action as Extract<BatchAction, { kind: K }>;
}

type T = ReturnType<typeof setup>;

const batches = (t: T) => t.sent.filter((s) => s.kind === 'batch');
const batchDeliveries = (t: T) =>
  t.deliveries.filter((d) => d.kind === 'review_batch' || d.kind === 'debt_reminder');

/** Первая порция выдана в основной слот и выучена через 30 минут. */
async function learnFirst(t: T) {
  await t.tick(MAIN);
  await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 30));
}

/** Выученная порция с заданными повторами — для проверок слияния. */
function addLearned(
  t: T,
  seq: number,
  lineStart: number,
  lineEnd: number,
  reviews: { dueAt: Date; status: 'pending' | 'sent' | 'missed' | 'confirmed' }[],
) {
  const id = 900 + seq;
  t.portions.push({
    id,
    planId: 1,
    seq,
    lineStart,
    lineEnd,
    status: 'learned',
    sentAt: at('2026-09-01T03:00:00Z'),
    learnedAt: at('2026-09-01T03:30:00Z'),
    anchorAt: at('2026-09-01T03:00:00Z'),
  });
  reviews.forEach((r, i) =>
    t.reviews.push({ id: id * 10 + i, portionId: id, stage: 'rep_1d', ...r }),
  );
  t.plan.nextLine = Math.max(t.plan.nextLine, lineEnd + 1);
}

describe('сводный повтор', () => {
  it('во второй слот — повтор +12 ч одним сообщением, повторный тик не дублирует', async () => {
    const t = setup();
    await learnFirst(t);
    await t.tick(minutes(SECOND, -1));
    expect(batches(t)).toHaveLength(0);

    await t.tick(SECOND);
    expect(batches(t)).toMatchObject([
      {
        batch: {
          kind: 'review',
          reviews: [{ lineStart: 1, lineEnd: 3, count: 3 }],
          portion: null,
          buttons: { confirm: true, learn: null },
        },
        lines: [[1, 3]],
      },
    ]);
    const [delivery] = batchDeliveries(t);
    expect(delivery).toMatchObject({
      kind: 'review_batch',
      status: 'sent',
      dedupeKey: 'batch:10:second:2026-09-16T15:00:00.000Z',
    });
    expect(t.reviews.filter((r) => r.deliveryId === delivery!.id)).toMatchObject([
      { stage: 'rep_12h', status: 'sent' },
    ]);

    // Догон: до вечера это то же событие — второго сообщения нет.
    await t.tick(minutes(SECOND, 1));
    await t.tick(minutes(EVENING, -1));
    expect(batches(t)).toHaveLength(1);
  });

  it('«Повторил(а)» — повторы отмечены, кнопка отметки исчезает, повторное нажатие безопасно', async () => {
    const t = setup();
    await learnFirst(t);
    await t.tick(SECOND);
    const id = batchDeliveries(t)[0]!.id;

    const done = expectKind(
      await t.reviewsApp.answer(USER, id, 'confirmed', minutes(SECOND, 5)),
      'answered',
    );
    expect(done.state.buttons).toEqual({ confirm: false, learn: null });
    // В эти плановые сутки порция уже была — следующая завтра в основной слот.
    expect(done.next).toEqual({ kind: 'at', at: MAIN_17 });
    expect(t.reviews.find((r) => r.stage === 'rep_12h')?.status).toBe('confirmed');

    const again = expectKind(
      await t.reviewsApp.answer(USER, id, 'confirmed', minutes(SECOND, 6)),
      'unchanged',
    );
    expect(again.portion).toBeNull();
    // Кнопки контекста продолжают работать.
    expect(await t.learning.captureMore(USER, id, minutes(SECOND, 7))).toEqual({
      kind: 'context_sent',
    });
    expect(t.sent.at(-1)).toMatchObject({ kind: 'pictures', lines: [[1, 3]] });
  });

  it('чужая или неизвестная сводка — кнопка неактуальна', async () => {
    const t = setup();
    await learnFirst(t);
    await t.tick(SECOND);
    const id = batchDeliveries(t)[0]!.id;
    expect(await t.reviewsApp.answer(8n, id, 'confirmed', SECOND)).toEqual({ kind: 'stale' });
    expect(await t.reviewsApp.answer(USER, 12345, 'confirmed', SECOND)).toEqual({
      kind: 'stale',
    });
    // Под сводкой без порции «Выучил» не работает.
    expect(await t.reviewsApp.learned(USER, id, SECOND)).toEqual({ kind: 'stale' });
  });

  it('«Не успел(а)» — повтор остаётся долгом: вечером напоминание, прежняя сводка теряет кнопки', async () => {
    const t = setup();
    await learnFirst(t);
    await t.tick(SECOND);
    const first = batchDeliveries(t)[0]!;
    const missed = expectKind(
      await t.reviewsApp.answer(USER, first.id, 'missed', minutes(SECOND, 5)),
      'answered',
    );
    expect(missed.next).toBeNull();
    expect(missed.state.buttons.confirm).toBe(false);
    expect(t.reviews.find((r) => r.stage === 'rep_12h')?.status).toBe('missed');

    await t.tick(EVENING);
    expect(batches(t)[1]).toMatchObject({
      batch: {
        kind: 'evening',
        reviews: [{ lineStart: 1, lineEnd: 3 }],
        buttons: { confirm: true, learn: null },
      },
    });
    const evening = batchDeliveries(t)[1]!;
    expect(evening).toMatchObject({ kind: 'debt_reminder', status: 'sent' });
    expect(t.deliveries.find((d) => d.id === first.id)?.status).toBe('replaced');
    expect(t.cleared).toContain(first.buttonsMessageId);
    expect(await t.reviewsApp.answer(USER, first.id, 'confirmed', EVENING)).toEqual({
      kind: 'stale',
    });

    // Утром — снова весь долг вместе с наступившим +1 д, новой порции нет.
    await t.tick(MAIN_17);
    expect(batches(t)[2]).toMatchObject({
      batch: { kind: 'debt', reviews: [{ lineStart: 1, lineEnd: 3 }] },
    });
    expect(t.portions).toHaveLength(1);
    const morning = batchDeliveries(t)[2]!;
    expect(t.reviews.filter((r) => r.deliveryId === morning.id).map((r) => r.stage)).toEqual([
      'rep_12h',
      'rep_1d',
    ]);

    // Долг закрыт до порога — порция приходит сразу.
    const done = expectKind(
      await t.reviewsApp.answer(USER, morning.id, 'confirmed', minutes(MAIN_17, 10)),
      'answered',
    );
    expect(done.next).toEqual({ kind: 'sent' });
    expect(t.portions.map((p) => [p.lineStart, p.lineEnd])).toEqual([
      [1, 3],
      [4, 6],
    ]);
  });

  it('второй слот не повторяет уже отправленные повторы', async () => {
    const t = setup();
    addLearned(t, 1, 1, 3, [{ dueAt: MAIN, status: 'missed' }]);
    addLearned(t, 2, 4, 6, [{ dueAt: SECOND, status: 'pending' }]);
    await t.tick(SECOND);
    expect(batches(t)).toMatchObject([
      { batch: { kind: 'review', reviews: [{ lineStart: 4, lineEnd: 6 }] } },
    ]);
  });

  it('основной слот: соседние диапазоны сливаются, несмежные — отдельно, пропуски не разрывают', async () => {
    const t = setup({ totalLines: 20 });
    t.skipped.add(7);
    addLearned(t, 1, 1, 3, [{ dueAt: MAIN, status: 'pending' }]);
    addLearned(t, 2, 4, 6, [{ dueAt: at('2026-09-15T15:00:00Z'), status: 'missed' }]);
    addLearned(t, 3, 8, 9, [{ dueAt: at('2026-09-15T03:00:00Z'), status: 'sent' }]);
    addLearned(t, 4, 13, 15, [{ dueAt: MAIN, status: 'pending' }]);
    addLearned(t, 5, 16, 18, [
      { dueAt: at('2026-09-18T03:00:00Z'), status: 'pending' },
      { dueAt: at('2026-09-14T03:00:00Z'), status: 'confirmed' },
    ]);
    await t.tick(MAIN);
    expect(batches(t)).toMatchObject([
      {
        batch: {
          kind: 'debt',
          reviews: [
            { lineStart: 1, lineEnd: 9, count: 8 },
            { lineStart: 13, lineEnd: 15, count: 3 },
          ],
          portion: null,
        },
        lines: [
          [1, 6],
          [8, 9],
          [13, 15],
        ],
      },
    ]);
    // Долг — новой порции нет.
    expect(t.portions).toHaveLength(5);

    // «Ещё ниже» — после последнего диапазона сообщения.
    const id = batchDeliveries(t)[0]!.id;
    await t.learning.neighbour(USER, id, 'down', minutes(MAIN, 1));
    expect(t.sent.at(-1)).toMatchObject({ kind: 'pictures', lines: [[16, 16]] });
    await t.learning.neighbour(USER, id, 'up', minutes(MAIN, 1));
    expect(await t.learning.neighbour(USER, id, 'up', minutes(MAIN, 1))).toMatchObject({
      kind: 'context_edge',
    });
  });

  it('вечером — невыученная порция дня; «Выучил» под напоминанием запускает повторы', async () => {
    const t = setup();
    await t.tick(MAIN);
    await t.tick(SECOND);
    expect(batches(t)).toHaveLength(0);

    await t.tick(EVENING);
    expect(batches(t)).toMatchObject([
      {
        batch: {
          kind: 'evening',
          reviews: [],
          portion: { lineStart: 1, lineEnd: 3 },
          buttons: { confirm: false, learn: { lineStart: 1, lineEnd: 3 } },
        },
        lines: [[1, 3]],
      },
    ]);
    const id = batchDeliveries(t)[0]!.id;
    const learned = expectKind(
      await t.reviewsApp.learned(USER, id, minutes(EVENING, 10)),
      'learned',
    );
    expect(learned.state.buttons).toEqual({ confirm: false, learn: null });
    expect(learned.action.next).toEqual({ kind: 'at', at: MAIN_17 });
    expect(t.portions[0]?.status).toBe('learned');

    const again = expectKind(
      await t.reviewsApp.learned(USER, id, minutes(EVENING, 11)),
      'unchanged',
    );
    expect(again.portion).toMatchObject({ lineStart: 1, lineEnd: 3 });
  });

  it('порция, выданная в основной слот, в утреннюю сводку не попадает', async () => {
    const t = setup();
    addLearned(t, 1, 1, 3, [{ dueAt: at('2026-09-17T03:00:00Z'), status: 'pending' }]);
    await t.tick(MAIN);
    expect(t.portions).toHaveLength(2);
    expect(batches(t)).toHaveLength(0);
  });

  it('ошибка отправки — сводка уходит следующим тиком', async () => {
    const t = setup();
    await learnFirst(t);
    t.fail({ ok: false, reason: 'error', error: new Error('500') });
    await t.tick(SECOND);
    expect(batchDeliveries(t)).toHaveLength(0);
    expect(t.reviews.find((r) => r.stage === 'rep_12h')?.status).toBe('pending');
    await t.tick(minutes(SECOND, 1));
    expect(batches(t)).toHaveLength(1);
  });

  it('после конца заучивания повторы продолжают приходить', async () => {
    const t = setup();
    addLearned(t, 1, 1, 12, [{ dueAt: SECOND, status: 'pending' }]);
    t.plan.status = 'learning_done';
    await t.tick(SECOND);
    expect(batches(t)).toHaveLength(1);
    const id = batchDeliveries(t)[0]!.id;
    const done = expectKind(await t.reviewsApp.answer(USER, id, 'confirmed', SECOND), 'answered');
    expect(done.next).toBeNull();
  });

  it('пауза — ничего не приходит', async () => {
    const t = setup();
    addLearned(t, 1, 1, 3, [{ dueAt: SECOND, status: 'pending' }]);
    t.user.pausedFrom = MAIN;
    await t.tick(SECOND);
    expect(batches(t)).toHaveLength(0);
  });
});

describe('долг дольше 3 плановых суток', () => {
  it('только сообщение основного слота; второй слот, вечер и напоминание про порцию молчат', async () => {
    const t = setup();
    addLearned(t, 1, 1, 3, [{ dueAt: at('2026-09-13T03:00:00Z'), status: 'missed' }]);
    t.reviews.push({
      id: 5000,
      portionId: 901,
      stage: 'rep_2w',
      dueAt: SECOND,
      status: 'pending',
    });
    await t.tick(MAIN);
    expect(batches(t)).toHaveLength(1);
    await t.tick(SECOND);
    await t.tick(EVENING);
    expect(batches(t)).toHaveLength(1);
    await t.tick(MAIN_17);
    expect(batches(t)).toHaveLength(2);
  });

  it('два дня долга — вечернее напоминание ещё приходит', async () => {
    const t = setup();
    addLearned(t, 1, 1, 3, [{ dueAt: at('2026-09-14T03:00:00Z'), status: 'missed' }]);
    await t.tick(EVENING);
    expect(batches(t)).toHaveLength(1);
  });

  it('напоминание про неотмеченную порцию не приходит', async () => {
    const t = setup();
    await t.tick(MAIN);
    t.portions[0]!.sentAt = at('2026-09-12T03:00:00Z');
    await t.tick(minutes(MAIN, 120));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(0);
  });
});

describe('закрытие цепочки', () => {
  it('после повтора через месяц порция закрыта, закрыты все — закрыт план', async () => {
    const t = setup();
    addLearned(t, 1, 1, 6, [{ dueAt: at('2026-09-10T03:00:00Z'), status: 'confirmed' }]);
    addLearned(t, 2, 7, 12, []);
    t.plan.status = 'learning_done';
    t.reviews.push(
      { id: 7001, portionId: 901, stage: 'rep_1m', dueAt: SECOND, status: 'pending' },
      { id: 7002, portionId: 902, stage: 'rep_2w', dueAt: SECOND, status: 'pending' },
    );
    await t.tick(SECOND);
    const first = batchDeliveries(t)[0]!.id;
    const partly = expectKind(
      await t.reviewsApp.answer(USER, first, 'confirmed', SECOND),
      'answered',
    );
    expect(partly.planCompleted).toBe(false);
    expect(t.portions.map((p) => p.status)).toEqual(['completed', 'learned']);
    expect(t.plan.status).toBe('learning_done');

    t.reviews.push({
      id: 7003,
      portionId: 902,
      stage: 'rep_1m',
      dueAt: MAIN_17,
      status: 'pending',
    });
    await t.tick(MAIN_17);
    const last = batchDeliveries(t)[1]!.id;
    const done = expectKind(
      await t.reviewsApp.answer(USER, last, 'confirmed', MAIN_17),
      'answered',
    );
    expect(done).toMatchObject({ planCompleted: true, next: null });
    expect(t.plan.status).toBe('completed');
    expect(t.portions.every((p) => p.status === 'completed')).toBe(true);
  });

  it('«Не успел(а)» порцию не закрывает', async () => {
    const t = setup();
    addLearned(t, 1, 1, 12, []);
    t.plan.status = 'learning_done';
    t.reviews.push({ id: 7001, portionId: 901, stage: 'rep_1m', dueAt: SECOND, status: 'pending' });
    await t.tick(SECOND);
    const id = batchDeliveries(t)[0]!.id;
    expect(await t.reviewsApp.answer(USER, id, 'missed', SECOND)).toMatchObject({
      planCompleted: false,
    });
    expect(t.portions[0]?.status).toBe('learned');
  });
});

describe('автопауза', () => {
  const WEEK_LATER = at('2026-09-22T12:00:00Z');

  it('7 дней без активности при долге — пауза, одно сообщение; «Продолжить» присылает весь долг', async () => {
    const t = setup();
    addLearned(t, 1, 1, 3, [{ dueAt: at('2026-09-16T03:00:00Z'), status: 'missed' }]);
    await t.tick(minutes(WEEK_LATER, -1));
    expect(t.user.pausedFrom).toBeNull();

    await t.tick(WEEK_LATER);
    expect(t.user.pausedFrom).toEqual(WEEK_LATER);
    expect(t.user.pausedUntil).toBeNull();
    expect(t.sent.filter((s) => s.kind === 'autopause')).toHaveLength(1);
    const before = batches(t).length;

    // На паузе ничего не приходит, повторно автопауза не ставится.
    await t.tick(at('2026-09-23T03:00:00Z'));
    await t.tick(at('2026-09-24T03:00:00Z'));
    expect(batches(t)).toHaveLength(before);
    expect(t.sent.filter((s) => s.kind === 'autopause')).toHaveLength(1);

    const resumeAt = at('2026-09-24T10:00:00Z');
    expect(await t.pause.resume(USER, resumeAt)).toEqual({ kind: 'resumed', debtMessages: 1 });
    expect(t.user.pausedFrom).toBeNull();
    expect(batches(t).at(-1)).toMatchObject({
      batch: { kind: 'debt', reviews: [{ lineStart: 1, lineEnd: 3 }] },
    });
    expect(await t.pause.resume(USER, resumeAt)).toEqual({ kind: 'not_paused' });
  });

  it('без долга пауза не ставится', async () => {
    const t = setup();
    addLearned(t, 1, 1, 12, [{ dueAt: at('2026-09-16T03:00:00Z'), status: 'confirmed' }]);
    t.plan.status = 'learning_done';
    await t.tick(WEEK_LATER);
    expect(t.user.pausedFrom).toBeNull();
  });

  it('не удалось сообщить — паузы нет, следующий тик пробует снова', async () => {
    const t = setup();
    addLearned(t, 1, 1, 3, [{ dueAt: at('2026-09-16T03:00:00Z'), status: 'missed' }]);
    t.fail({ ok: false, reason: 'error', error: new Error('500') });
    await t.tick(WEEK_LATER);
    expect(t.user.pausedFrom).toBeNull();
    await t.tick(minutes(WEEK_LATER, 1));
    expect(t.user.pausedFrom).toEqual(minutes(WEEK_LATER, 1));
  });

  it('после продолжения без долга порция приходит по правилу «сейчас или в слот»', async () => {
    const t = setup();
    t.user.pausedFrom = at('2026-09-15T00:00:00Z');
    expect(await t.pause.resume(USER, minutes(MAIN, 60))).toEqual({
      kind: 'resumed',
      debtMessages: 0,
    });
    expect(t.portions).toHaveLength(1);
  });
});

describe('успеть к сроку / сдвинуть срок', () => {
  // Порция 16.09 выучена только 17.09 в 22:00 МСК — порция 17.09 пропущена.
  const LATE = at('2026-09-17T19:00:00Z');

  async function lateLearn(t: T) {
    await t.tick(MAIN);
    expect(t.plan.estimatedEndDate).toBe('2026-09-19');
    await t.tick(MAIN_17);
    const learned = await t.learning.learned(USER, t.lastPortionDelivery().id, LATE);
    return learned as Extract<typeof learned, { kind: 'learned' }>;
  }

  it('по количеству в день — новая дата без вопроса', async () => {
    const t = setup();
    const learned = await lateLearn(t);
    expect(learned.next).toEqual({ kind: 'at', at: at('2026-09-18T03:00:00Z') });
    expect(learned.pace?.check).toEqual({
      kind: 'shifted',
      endDate: '2026-09-20',
      previous: '2026-09-19',
    });
    expect(t.plan.estimatedEndDate).toBe('2026-09-20');
  });

  it('по сроку — выбор; «Успеть к сроку» повышает норму', async () => {
    const t = setup();
    Object.assign(t.plan, { paceMode: 'deadline', deadlineDate: '2026-09-19' });
    const learned = await lateLearn(t);
    expect(learned.pace).toMatchObject({
      planId: 1,
      unitsPerDay: 3,
      check: {
        kind: 'behind',
        deadline: '2026-09-19',
        shiftEndDate: '2026-09-20',
        catchUpUnitsPerDay: 5,
        catchUpEndDate: '2026-09-19',
        adviseShift: false,
      },
    });
    expect(t.plan.estimatedEndDate).toBe('2026-09-19');

    expect(await t.learning.choosePace(8n, 1, 'catch_up', LATE)).toEqual({ kind: 'stale' });
    expect(await t.learning.choosePace(USER, 1, 'catch_up', LATE)).toMatchObject({
      kind: 'caught_up',
      unitsPerDay: 5,
      endDate: '2026-09-19',
    });
    expect(t.plan).toMatchObject({ unitsPerDay: 5, estimatedEndDate: '2026-09-19' });
    // Уже успеваем — старые кнопки неактуальны.
    expect(await t.learning.choosePace(USER, 1, 'shift', LATE)).toEqual({ kind: 'stale' });

    // «Выучил» в 22:00 округлён к 18:00 — утром 18.09 сначала повтор +12 ч, затем порция по новой норме.
    const MAIN_18 = at('2026-09-18T03:00:00Z');
    await t.tick(MAIN_18);
    const batch = batchDeliveries(t).at(-1)!.id;
    await t.reviewsApp.answer(USER, batch, 'confirmed', minutes(MAIN_18, 5));
    expect(t.portions.at(-1)).toMatchObject({ lineStart: 4, lineEnd: 8 });
  });

  it('«Сдвинуть срок» — прежняя норма, новая дата и срок', async () => {
    const t = setup();
    Object.assign(t.plan, { paceMode: 'deadline', deadlineDate: '2026-09-19' });
    await lateLearn(t);
    expect(await t.learning.choosePace(USER, 1, 'shift', LATE)).toEqual({
      kind: 'shifted',
      title: 'Манзума',
      endDate: '2026-09-20',
    });
    expect(t.plan).toMatchObject({
      unitsPerDay: 3,
      deadlineDate: '2026-09-20',
      estimatedEndDate: '2026-09-20',
    });
  });

  it('вовремя — ни сообщения, ни вопроса', async () => {
    const t = setup();
    await t.tick(MAIN);
    const learned = await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 30));
    expect(learned).toMatchObject({ kind: 'learned', pace: null });
  });

  it('после «Повторил(а)» тоже проверяется темп', async () => {
    const t = setup();
    Object.assign(t.plan, { paceMode: 'deadline', deadlineDate: '2026-09-19' });
    await t.tick(MAIN);
    await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 30));
    await t.tick(SECOND);
    await t.tick(MAIN_17);
    // Весь долг отмечен только вечером 17.09, после порога — порция 17.09 пропущена.
    const id = batchDeliveries(t).at(-1)!.id;
    const done = expectKind(await t.reviewsApp.answer(USER, id, 'confirmed', LATE), 'answered');
    expect(done.pace?.check.kind).toBe('behind');
  });
});
