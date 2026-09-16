import { describe, expect, it } from 'vitest';
import {
  computePace,
  decodeDeadlineInput,
  encodeDeadlineInput,
  resolveDeadline,
  type DeadlineInput,
} from './pace.js';

const WED = '2026-09-16';

describe('срок', () => {
  it('дни и месяцы считаются включая дату начала, месяц = 30 дней', () => {
    expect(resolveDeadline(WED, { kind: 'days', value: 1 })).toBe(WED);
    expect(resolveDeadline(WED, { kind: 'days', value: 7 })).toBe('2026-09-22');
    expect(resolveDeadline(WED, { kind: 'months', value: 1 })).toBe('2026-10-15');
    expect(resolveDeadline(WED, { kind: 'months', value: 12 })).toBe('2027-09-10');
    expect(resolveDeadline(WED, { kind: 'date', date: '2026-12-30' })).toBe('2026-12-30');
  });

  it.each<[DeadlineInput, string]>([
    [{ kind: 'days', value: 90 }, 'days:90'],
    [{ kind: 'months', value: 3 }, 'months:3'],
    [{ kind: 'date', date: '2026-12-30' }, 'date:2026-12-30'],
  ])('кодирует %o как %s и обратно', (input, encoded) => {
    expect(encodeDeadlineInput(input)).toBe(encoded);
    expect(decodeDeadlineInput(encoded)).toEqual(input);
  });

  it.each(['days:0', 'days:x', 'weeks:2', 'date:2026-02-30', ''])('отвергает «%s»', (value) => {
    expect(decodeDeadlineInput(value)).toBeNull();
  });
});

describe('темп по сроку', () => {
  it('норма = ceil(единиц / рабочих дней)', () => {
    const result = computePace({
      totalUnits: 448,
      startDate: WED,
      restDays: [],
      pace: { mode: 'deadline', deadline: { kind: 'months', value: 3 } },
    });
    expect(result).toMatchObject({
      ok: true,
      unitsPerDay: 5,
      portions: 90,
      endDate: '2026-12-14',
      deadlineDate: '2026-12-14',
      endsEarly: false,
    });
  });

  it('выходные уменьшают число рабочих дней и увеличивают норму', () => {
    const result = computePace({
      totalUnits: 60,
      startDate: WED,
      restDays: [6, 7],
      pace: { mode: 'deadline', deadline: { kind: 'days', value: 14 } },
    });
    // 16.09–29.09: 10 рабочих дней
    expect(result).toMatchObject({ ok: true, unitsPerDay: 6, portions: 10, endDate: '2026-09-29' });
  });

  it('единиц меньше, чем рабочих дней, — по одной в день, закончится раньше срока', () => {
    const result = computePace({
      totalUnits: 5,
      startDate: WED,
      restDays: [],
      pace: { mode: 'deadline', deadline: { kind: 'days', value: 30 } },
    });
    expect(result).toMatchObject({
      ok: true,
      unitsPerDay: 1,
      portions: 5,
      endDate: '2026-09-20',
      endsEarly: true,
    });
  });

  it('округление нормы вверх может закончить план раньше срока', () => {
    const result = computePace({
      totalUnits: 10,
      startDate: WED,
      restDays: [],
      pace: { mode: 'deadline', deadline: { kind: 'days', value: 6 } },
    });
    expect(result).toMatchObject({ unitsPerDay: 2, portions: 5, endsEarly: true });
  });

  it('дата раньше начала и срок без рабочих дней — ошибки', () => {
    expect(
      computePace({
        totalUnits: 10,
        startDate: WED,
        restDays: [],
        pace: { mode: 'deadline', deadline: { kind: 'date', date: '2026-09-15' } },
      }),
    ).toEqual({ ok: false, reason: 'deadline_before_start' });
    expect(
      computePace({
        totalUnits: 10,
        startDate: '2026-09-19',
        restDays: [6, 7],
        pace: { mode: 'deadline', deadline: { kind: 'date', date: '2026-09-20' } },
      }),
    ).toEqual({ ok: false, reason: 'no_working_days' });
  });

  it('дата начала в выходной — первая порция в ближайший рабочий день', () => {
    const result = computePace({
      totalUnits: 10,
      startDate: '2026-09-19',
      restDays: [6, 7],
      pace: { mode: 'deadline', deadline: { kind: 'days', value: 7 } },
    });
    expect(result).toMatchObject({ ok: true, firstDate: '2026-09-21', unitsPerDay: 2 });
  });
});

describe('темп по количеству в день', () => {
  it('дата окончания — последний рабочий день', () => {
    const result = computePace({
      totalUnits: 448,
      startDate: WED,
      restDays: [5],
      pace: { mode: 'per_day', unitsPerDay: 5 },
    });
    expect(result).toMatchObject({ ok: true, unitsPerDay: 5, portions: 90, deadlineDate: null });
    if (result.ok) expect(result.endDate > '2026-12-14').toBe(true);
  });

  it('норма больше текста — одна порция', () => {
    const result = computePace({
      totalUnits: 3,
      startDate: WED,
      restDays: [],
      pace: { mode: 'per_day', unitsPerDay: 10 },
    });
    expect(result).toMatchObject({ unitsPerDay: 3, portions: 1, endDate: WED });
  });

  it('норма должна быть ≥ 1', () => {
    expect(() =>
      computePace({
        totalUnits: 3,
        startDate: WED,
        restDays: [],
        pace: { mode: 'per_day', unitsPerDay: 0 },
      }),
    ).toThrow();
  });
});
