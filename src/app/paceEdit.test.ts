import { describe, expect, it } from 'vitest';
import { limits } from '../config/limits.js';
import { at, MAIN, minutes, setup, USER } from './learning.fixture.js';
import { createPaceEdit, type PaceEditScreen } from './paceEdit.js';

// 16.09.2026 (ср), 12 бейтов по 3 в день, без выходных.
const NOON = at('2026-09-16T09:00:00Z');

function build() {
  const t = setup();
  const paceEdit = createPaceEdit({ store: t.store, dialogs: t.dialogs, limits: limits.plan });
  return { t, paceEdit };
}

function expectKind<K extends PaceEditScreen['kind']>(screen: PaceEditScreen | null, kind: K) {
  expect(screen?.kind).toBe(kind);
  return screen as Extract<PaceEditScreen, { kind: K }>;
}

describe('смена темпа', () => {
  it('по количеству в день: только невыданные, начиная со следующих суток', async () => {
    const { t, paceEdit } = build();
    await t.tick(MAIN);
    const mode = expectKind(await paceEdit.open(USER, 1, NOON), 'mode');
    expect(mode).toMatchObject({ paceMode: 'per_day', unitsPerDay: 3, remaining: 9 });
    expectKind(await paceEdit.act(USER, 1, 'mode', 'per_day', NOON), 'per_day');
    expect(expectKind(await paceEdit.handleText(USER, '10', NOON), 'per_day').invalid).toBe(true);
    const preview = expectKind(await paceEdit.handleText(USER, '2', NOON), 'preview');
    expect(preview.from).toBe('2026-09-17');
    expect(preview.summary).toMatchObject({ unitsPerDay: 2, endDate: '2026-09-21' });

    const saved = expectKind(await paceEdit.act(USER, 1, 'save', '', NOON), 'saved');
    expect(saved).toMatchObject({ unitsPerDay: 2, endDate: '2026-09-21' });
    expect(t.plan).toMatchObject({
      paceMode: 'per_day',
      unitsPerDay: 2,
      deadlineDate: null,
      estimatedEndDate: '2026-09-21',
    });
    // Выданная порция не изменилась.
    expect(t.portions).toMatchObject([{ lineStart: 1, lineEnd: 3 }]);
    // Повторное сохранение — кнопка неактуальна.
    expect(await paceEdit.act(USER, 1, 'save', '', NOON)).toEqual({ kind: 'stale' });
  });

  it('по сроку: кнопка дней, ввод даты, ошибки', async () => {
    const { t, paceEdit } = build();
    // Порции сегодня ещё не было — отсчёт с сегодняшнего дня (и не раньше начала плана).
    const early = at('2026-09-16T01:00:00Z');
    await paceEdit.open(USER, 1, early);
    expect(
      expectKind(await paceEdit.act(USER, 1, 'mode', 'deadline', early), 'deadline_kind').from,
    ).toBe('2026-09-16');

    const days = expectKind(await paceEdit.act(USER, 1, 'dlv', 'days.2', NOON), 'preview');
    expect(days.summary).toMatchObject({ unitsPerDay: 6, deadlineDate: '2026-09-17' });

    await paceEdit.act(USER, 1, 'dlk', 'date', NOON);
    expect(expectKind(await paceEdit.handleText(USER, 'скоро', NOON), 'deadline_input').error).toBe(
      'format',
    );
    expect(
      expectKind(await paceEdit.handleText(USER, '01.09.2026', NOON), 'deadline_input').error,
    ).toBe('deadline_before_start');
    expect(
      expectKind(await paceEdit.handleText(USER, '01.09.2030', NOON), 'deadline_input').error,
    ).toBe('too_long');
    const date = expectKind(await paceEdit.handleText(USER, '19.09.2026', NOON), 'preview');
    expect(date.summary).toMatchObject({ unitsPerDay: 3, deadlineDate: '2026-09-19' });
    await paceEdit.act(USER, 1, 'save', '', NOON);
    expect(t.plan).toMatchObject({
      paceMode: 'deadline',
      deadlineDate: '2026-09-19',
      deadlineInput: 'date:2026-09-19',
    });
  });

  it('перегрузка показывается в предпросмотре', async () => {
    const { paceEdit } = build();
    const preview = expectKind(await paceEdit.act(USER, 1, 'upd', '12', NOON), 'preview');
    expect(preview.summary.unitsPerDay).toBe(12);
    expect(preview.summary.overload.unitsPerDay).toBe(true);
  });

  it('чужой план, законченный план, всё выдано', async () => {
    const { t, paceEdit } = build();
    expect(await paceEdit.open(8n, 1, NOON)).toEqual({ kind: 'stale' });
    t.plan.nextLine = 13;
    expect(await paceEdit.open(USER, 1, NOON)).toEqual({ kind: 'nothing_left', title: 'Манзума' });
    t.plan.status = 'learning_done';
    expect(await paceEdit.open(USER, 1, NOON)).toEqual({ kind: 'stale' });
    expect(await paceEdit.handleText(USER, '3', minutes(NOON, 1))).toBeNull();
  });
});
