import { describe, expect, it } from 'vitest';
import { at, MAIN, minutes, setup, USER } from './learning.fixture.js';
import { createLibrary, type LibraryScreen } from './library.js';
import type { LibraryStore } from './ports.js';

// 16.09.2026, МСК, основной слот 06:00 (03:00 UTC), второй — 18:00 (15:00 UTC).
const SECOND = at('2026-09-16T15:00:00Z');

function build(options: { withPlan?: boolean } = {}) {
  const t = setup();
  const removed: number[] = [];
  let deletedUser = false;
  let textDeleted = false;
  const portionRange = (id: number) => t.portions.find((p) => p.id === id)!;
  const library: LibraryStore = {
    listTexts: async () =>
      deletedUser || textDeleted
        ? []
        : [
            {
              id: 10,
              title: 'Манзума',
              unitName: 'bayts',
              parseStrategy: 'numbers',
              totalLines: 12,
              plan: options.withPlan === false ? null : { ...t.plan },
            },
          ],
    portions: async () => t.portions.map((p) => ({ ...p })),
    reviews: async () =>
      t.reviews
        .filter((r) => r.stage !== 'learn_reminder' && r.status !== 'cancelled')
        .map((r) => ({
          dueAt: r.dueAt,
          status: r.status,
          confirmedAt: r.status === 'confirmed' ? r.dueAt : null,
          lineStart: portionRange(r.portionId).lineStart,
          lineEnd: portionRange(r.portionId).lineEnd,
        })),
    deleteText: async (_u, id) => {
      textDeleted = id === 10;
      return textDeleted;
    },
    deleteUser: async () => {
      deletedUser = true;
      return [10];
    },
  };
  const app = createLibrary({
    library,
    store: t.store,
    learning: t.learning,
    reviews: t.reviewsApp,
    files: { removeText: async (id) => void removed.push(id) },
  });
  return { t, app, removed };
}

function expectKind<K extends LibraryScreen['kind']>(screen: LibraryScreen, kind: K) {
  expect(screen.kind).toBe(kind);
  return screen as Extract<LibraryScreen, { kind: K }>;
}

describe('тексты и прогресс', () => {
  it('прогресс: выучено, повторы, серия', async () => {
    const { t, app } = build();
    await t.tick(MAIN);
    await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 30));
    await t.tick(SECOND);
    const progress = expectKind(await app.progress(USER, minutes(SECOND, 10)), 'progress');
    expect(progress.texts[0]?.plan).toMatchObject({
      learnedUnits: 3,
      totalUnits: 12,
      percent: 25,
      reviewsDone: 0,
      reviewsMissed: 0,
      unitsPerDay: 3,
      estimatedEndDate: '2026-09-19',
      streak: 0,
      lastReviewDate: '2026-10-16',
    });
  });

  it('список, карточка, текст без плана', async () => {
    const { app } = build({ withPlan: false });
    const list = expectKind(await app.texts(USER, MAIN), 'texts');
    expect(list.texts[0]).toMatchObject({ title: 'Манзума', plan: null });
    expect(expectKind(await app.card(USER, 10, MAIN), 'card').text.plan).toBeNull();
    expect(await app.card(USER, 99, MAIN)).toEqual({ kind: 'stale' });
    expect(await app.progress(USER, MAIN)).toEqual({ kind: 'no_texts' });
  });

  it('выбор текста для темпа — только идущие планы, по id плана', async () => {
    const { app, t } = build();
    expect(await app.pick(USER, 'pace')).toMatchObject({
      purpose: 'pace',
      texts: [{ id: 1, title: 'Манзума' }],
    });
    t.plan.status = 'learning_done';
    expect(await app.pick(USER, 'pace')).toEqual({ kind: 'no_texts' });
    expect(await app.pick(USER, 'delete')).toMatchObject({ texts: [{ id: 10 }] });
  });
});

describe('на сегодня', () => {
  it('порция выдана, долгов нет, повтор ещё впереди', async () => {
    const { t, app } = build();
    await t.tick(MAIN);
    await t.learning.learned(USER, t.lastPortionDelivery().id, minutes(MAIN, 30));
    const today = expectKind(await app.today(USER, minutes(MAIN, 60)), 'today');
    expect(today.paused).toBeNull();
    expect(today.texts).toMatchObject([
      {
        portion: { kind: 'issued', lineStart: 1, lineEnd: 3, learned: true },
        owed: [],
        unlearned: null,
        later: [{ lineStart: 1, lineEnd: 3 }],
      },
    ]);
  });

  it('долг: невыученная вчерашняя порция и «прислать долг сейчас»', async () => {
    const { t, app } = build();
    await t.tick(MAIN);
    const next = at('2026-09-17T04:00:00Z');
    const today = expectKind(await app.today(USER, next), 'today');
    expect(today.texts[0]).toMatchObject({
      portion: { kind: 'debt' },
      unlearned: { lineStart: 1, lineEnd: 3 },
    });
    expect(await app.sendDebt(USER, 10, next)).toEqual({ kind: 'debt_sent', messages: 1 });
    expect(t.sent.filter((s) => s.kind === 'batch')).toHaveLength(1);
    expect(await app.sendDebt(USER, 99, next)).toEqual({ kind: 'stale' });
  });

  it('до первой порции — когда придёт; на паузе — пауза', async () => {
    const { t, app } = build();
    const early = at('2026-09-16T01:00:00Z');
    expect(expectKind(await app.today(USER, early), 'today').texts[0]?.portion).toEqual({
      kind: 'at',
      at: MAIN,
    });
    t.user.pausedFrom = early;
    const paused = expectKind(await app.today(USER, early), 'today');
    expect(paused.paused).toEqual({ until: null });
    expect(await app.sendDebt(USER, 10, early)).toEqual({ kind: 'stale' });
  });
});

describe('удаление', () => {
  it('текст: подтверждение, удаление, файлы', async () => {
    const { app, removed } = build();
    expect(await app.askDelete(USER, 10)).toEqual({
      kind: 'delete_confirm',
      textId: 10,
      title: 'Манзума',
    });
    expect(await app.deleteText(USER, 10)).toEqual({ kind: 'deleted', title: 'Манзума' });
    expect(removed).toEqual([10]);
    expect(await app.deleteText(USER, 10)).toEqual({ kind: 'stale' });
  });

  it('все данные — два подтверждения', async () => {
    const { app, removed } = build();
    expect(app.askWipe(1)).toEqual({ kind: 'wipe_confirm', step: 1 });
    expect(app.askWipe(2)).toEqual({ kind: 'wipe_confirm', step: 2 });
    expect(await app.wipe(USER)).toEqual({ kind: 'wiped' });
    expect(removed).toEqual([10]);
  });
});
