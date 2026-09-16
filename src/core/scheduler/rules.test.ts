import { describe, expect, it } from 'vitest';
import {
  decideIssue,
  estimateEndDate,
  eveningReminderAt,
  hasDebt,
  immediateThreshold,
  pickPortion,
  type IssueInput,
  type ScheduleRules,
} from './rules.js';

const at = (s: string) => new Date(s);
const iso = (d: Date | null) => d?.toISOString() ?? null;
const rules = (dailySendTime: string, eveningReminderTime = '21:00'): ScheduleRules => ({
  timezone: 'Europe/Moscow',
  dailySendTime,
  eveningReminderTime,
});

describe('долг', () => {
  const now = at('2026-09-16T10:00:00Z');
  it('невыученная порция', () => {
    expect(hasDebt(now, { unlearnedPortion: true, reviews: [] })).toBe(true);
  });
  it('наступивший неподтверждённый повтор', () => {
    const due = at('2026-09-16T09:00:00Z');
    for (const status of ['pending', 'sent', 'missed'] as const) {
      expect(hasDebt(now, { unlearnedPortion: false, reviews: [{ dueAt: due, status }] })).toBe(
        true,
      );
    }
    for (const status of ['confirmed', 'cancelled'] as const) {
      expect(hasDebt(now, { unlearnedPortion: false, reviews: [{ dueAt: due, status }] })).toBe(
        false,
      );
    }
  });
  it('будущий повтор — не долг', () => {
    expect(
      hasDebt(now, {
        unlearnedPortion: false,
        reviews: [{ dueAt: at('2026-09-16T11:00:00Z'), status: 'pending' }],
      }),
    ).toBe(false);
  });
});

describe('вечернее напоминание', () => {
  it.each([
    // основной слот, вечер, срабатывает ли (время МСК)
    ['06:00', '21:00', '2026-09-16T18:00:00.000Z'],
    ['20:00', '21:00', null], // через час после слота
    ['22:00', '21:00', null], // 21:00 следующей даты — за час до следующего слота
    ['12:00', '21:00', '2026-09-16T18:00:00.000Z'],
    ['05:00', '03:00', null], // 03:00 ночи — за 2 часа до следующего слота
  ])('слот %s, напоминание %s → %s', (main, evening, expected) => {
    expect(iso(eveningReminderAt('2026-09-16', rules(main, evening)))).toBe(expected);
  });

  it('порог без вечернего напоминания — за 3 часа до следующего слота', () => {
    expect(iso(immediateThreshold('2026-09-16', rules('20:00')))).toBe('2026-09-17T14:00:00.000Z');
    expect(iso(immediateThreshold('2026-09-16', rules('06:00')))).toBe('2026-09-16T18:00:00.000Z');
  });
});

describe('выдать сейчас или в слот', () => {
  const base: IssueInput = {
    now: at('2026-09-16T08:00:00Z'), // ср 11:00 МСК
    rules: rules('06:00'),
    startDate: '2026-09-16',
    restDays: [],
    lastPortionSentAt: null,
    debt: false,
    hasUnits: true,
  };

  it('в основной слот рабочего дня — сразу', () => {
    expect(decideIssue({ ...base, now: at('2026-09-16T03:00:00Z') })).toEqual({ kind: 'now' });
  });

  it('до порога — сразу, после — в следующий основной слот', () => {
    expect(decideIssue(base)).toEqual({ kind: 'now' });
    expect(decideIssue({ ...base, now: at('2026-09-16T18:00:00Z') })).toEqual({
      kind: 'at',
      at: at('2026-09-17T03:00:00Z'),
    });
  });

  it('ночью до основного слота — это ещё прошлые сутки, порог прошёл', () => {
    expect(decideIssue({ ...base, now: at('2026-09-16T01:00:00Z') })).toEqual({
      kind: 'at',
      at: at('2026-09-16T03:00:00Z'),
    });
  });

  it('порция уже выдана в эти сутки', () => {
    expect(decideIssue({ ...base, lastPortionSentAt: at('2026-09-16T03:00:10Z') })).toEqual({
      kind: 'at',
      at: at('2026-09-17T03:00:00Z'),
    });
    // Вчерашняя порция не мешает.
    expect(decideIssue({ ...base, lastPortionSentAt: at('2026-09-15T03:00:10Z') })).toEqual({
      kind: 'now',
    });
  });

  it('выходной — в основной слот следующего рабочего дня', () => {
    expect(decideIssue({ ...base, restDays: [3, 4] })).toEqual({
      kind: 'at',
      at: at('2026-09-18T03:00:00Z'),
    });
  });

  it('дата начала в будущем', () => {
    expect(decideIssue({ ...base, startDate: '2026-10-01' })).toEqual({
      kind: 'at',
      at: at('2026-10-01T03:00:00Z'),
    });
  });

  it('долг и конец плана', () => {
    expect(decideIssue({ ...base, debt: true })).toEqual({ kind: 'blocked', reason: 'debt' });
    expect(decideIssue({ ...base, hasUnits: false })).toEqual({
      kind: 'blocked',
      reason: 'done',
    });
  });
});

describe('порция и дата окончания', () => {
  const units = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ lineNumber: n, skipped: n === 2 || n === 3 }));

  it('пропущенные единицы не считаются', () => {
    expect(pickPortion(units, 1, 7, 3)).toEqual({ lineStart: 1, lineEnd: 5, count: 3 });
    expect(pickPortion(units, 2, 7, 2)).toEqual({ lineStart: 4, lineEnd: 5, count: 2 });
    expect(pickPortion(units, 6, 7, 5)).toEqual({ lineStart: 6, lineEnd: 7, count: 2 });
    expect(pickPortion(units, 6, 6, 5)).toEqual({ lineStart: 6, lineEnd: 6, count: 1 });
    expect(pickPortion(units, 8, 7, 5)).toBeNull();
    expect(pickPortion(units, 2, 3, 5)).toBeNull();
  });

  it('дата окончания по оставшимся единицам', () => {
    expect(estimateEndDate('2026-09-16', 10, 5, [], '2026-09-16')).toBe('2026-09-18');
    expect(estimateEndDate('2026-09-16', 11, 5, [5], '2026-09-16')).toBe('2026-09-20');
    expect(estimateEndDate('2026-09-16', 0, 5, [], '2026-09-16')).toBe('2026-09-16');
    expect(estimateEndDate('2026-09-16', 5, 5, [], '2026-10-01')).toBe('2026-10-01');
  });
});
