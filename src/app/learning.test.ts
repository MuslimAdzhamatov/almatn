import { describe, expect, it } from 'vitest';
import { at, MAIN, minutes, setup, USER } from './learning.fixture.js';
import type { PortionAction } from './learning.js';

function expectKind<K extends PortionAction['kind']>(action: PortionAction, kind: K) {
  expect(action.kind).toBe(kind);
  return action as Extract<PortionAction, { kind: K }>;
}

describe('выдача порций', () => {
  it('в основной слот — первая порция с напоминанием через 2 часа', async () => {
    const t = setup();
    expect(await t.tick(MAIN)).toBe(true);
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
    await t.tick(minutes(MAIN, 1));
    expect(t.portions).toHaveLength(1);
  });

  it('невыученная порция — долг, новая не приходит; после «Выучил» — в следующий слот', async () => {
    const t = setup();
    await t.tick(MAIN);
    const nextDay = at('2026-09-17T03:00:00Z');
    await t.tick(nextDay);
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
    await t.tick(MAIN);
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
    await t.tick(MAIN);
    await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 5));
    // 17.09 06:00: повтор +12 ч (16.09 18:00) не подтверждён.
    await t.tick(at('2026-09-17T03:00:00Z'));
    expect(t.portions).toHaveLength(1);
    t.reviews.filter((r) => r.stage === 'rep_12h').forEach((r) => (r.status = 'confirmed'));
    // В тот же слот наступил и повтор +1 сутки — тоже долг.
    await t.tick(at('2026-09-17T03:01:00Z'));
    expect(t.portions).toHaveLength(1);
    t.reviews.filter((r) => r.stage === 'rep_1d').forEach((r) => (r.status = 'confirmed'));
    await t.tick(at('2026-09-17T03:02:00Z'));
    expect(t.portions).toHaveLength(2);
  });

  it('последняя порция короче; после неё план — learning_done', async () => {
    const t = setup({ totalLines: 4 });
    await t.tick(MAIN);
    await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 5));
    for (const r of t.reviews) r.status = 'confirmed';
    const day2 = at('2026-09-17T03:00:00Z');
    await t.tick(day2);
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
    await rest.tick(MAIN);
    expect(rest.portions).toHaveLength(0);

    const paused = setup();
    paused.user.pausedFrom = at('2026-09-15T00:00:00Z');
    await paused.tick(MAIN);
    expect(paused.portions).toHaveLength(0);
    expect(await paused.learning.preview(1, MAIN)).toEqual({ kind: 'paused' });

    const blocked = setup();
    blocked.fail({ ok: false, reason: 'blocked', error: new Error('403') });
    await blocked.tick(MAIN);
    expect(blocked.portions).toHaveLength(0);
    expect(blocked.plan.nextLine).toBe(1);
    expect(blocked.user.blockedAt).toEqual(MAIN);
    await blocked.tick(minutes(MAIN, 1));
    expect(blocked.portions).toHaveLength(0);
  });

  it('ошибка отправки — порция откатывается и уходит следующим тиком', async () => {
    const t = setup();
    t.fail({ ok: false, reason: 'error', error: new Error('500') });
    await t.tick(MAIN);
    expect(t.portions).toHaveLength(0);
    expect(t.plan.nextLine).toBe(1);
    expect(t.errors).toHaveLength(1);
    await t.tick(minutes(MAIN, 1));
    expect(t.portions).toHaveLength(1);
  });

  it('догон: бот был выключен в слот — порция приходит при запуске до порога', async () => {
    const t = setup();
    expect(await t.learning.preview(1, at('2026-09-16T02:00:00Z'))).toEqual({
      kind: 'at',
      at: MAIN,
    });
    await t.tick(at('2026-09-16T09:00:00Z'));
    expect(t.portions).toHaveLength(1);
  });

  it('одновременный тик пропускается', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.tick(MAIN), t.tick(MAIN)]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(t.portions).toHaveLength(1);
  });
});

describe('напоминание про неотмеченную порцию', () => {
  it('одно напоминание через 2 часа', async () => {
    const t = setup();
    await t.tick(MAIN);
    await t.tick(minutes(MAIN, 119));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(0);
    await t.tick(minutes(MAIN, 120));
    await t.tick(minutes(MAIN, 121));
    const reminders = t.sent.filter((s) => s.kind === 'reminder');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.view).toMatchObject({ lineStart: 1, lineEnd: 3, count: 3 });
    // Кнопки напоминания тоже отмечают порцию.
    const reminder = t.deliveries.find((d) => d.kind === 'learn_reminder')!;
    expectKind(await t.learning.learned(USER, reminder.id, minutes(MAIN, 130)), 'learned');
  });

  it('«Ещё учу» отменяет, «Напомнить позже» — через час', async () => {
    const t = setup();
    await t.tick(MAIN);
    const id = t.lastPortionDelivery().id;
    expectKind(await t.learning.stillLearning(USER, id), 'still_learning');
    await t.tick(minutes(MAIN, 130));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(0);

    const later = expectKind(
      await t.learning.remindLater(USER, id, minutes(MAIN, 130)),
      'remind_later',
    );
    expect(later.at).toEqual(minutes(MAIN, 190));
    await t.tick(minutes(MAIN, 190));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(1);
  });

  it('ночное напоминание при политике move ждёт утра', async () => {
    const t = setup();
    t.user.nightPolicy = 'move';
    await t.tick(MAIN);
    const id = t.lastPortionDelivery().id;
    // «Напомнить позже» в 22:30 МСК → 23:30, это ночь → 07:00.
    const late = at('2026-09-16T19:30:00Z');
    const later = expectKind(await t.learning.remindLater(USER, id, late), 'remind_later');
    expect(later.at).toEqual(at('2026-09-17T04:00:00Z'));
    await t.tick(minutes(late, 60));
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(0);
  });
});

describe('кнопки контекста', () => {
  it('«Захватить больше» — до трёх раз с растущим запасом', async () => {
    const t = setup();
    await t.tick(MAIN);
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
    await t.tick(MAIN);
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
    await t.tick(MAIN);
    expectKind(await t.learning.captureMore(99n, t.lastPortionDelivery().id, MAIN), 'stale');
    expectKind(await t.learning.learned(USER, 12345, MAIN), 'stale');
  });
});

describe('пропуск единиц', () => {
  it('выбор, замена порции и новая дата окончания', async () => {
    const t = setup();
    await t.tick(MAIN);
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
    await t.tick(MAIN);
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
    await t.tick(MAIN);
    const one = expectKind(
      await t.learning.skipMenu(USER, t.lastPortionDelivery().id, MAIN),
      'skipped',
    );
    expect(one.portion).toMatchObject({ lineStart: 2, lineEnd: 2 });

    const all = setup();
    await all.tick(MAIN);
    const r = expectKind(
      await all.learning.skip(USER, all.lastPortionDelivery().id, null, MAIN),
      'skipped',
    );
    expect(r.skipped).toEqual([1, 2, 3]);
    expect(r.portion).toMatchObject({ lineStart: 4, lineEnd: 6 });
  });

  it('учить больше нечего — порция удаляется, план закончен', async () => {
    const t = setup({ totalLines: 2 });
    await t.tick(MAIN);
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
    await t.tick(MAIN);
    const id = t.lastPortionDelivery().id;
    await t.learning.learned(USER, id, MAIN);
    expectKind(await t.learning.skipMenu(USER, id, MAIN), 'already_learned');
    expectKind(await t.learning.skip(USER, id, null, MAIN), 'already_learned');
  });
});
