import { describe, expect, it } from 'vitest';
import {
  buildPortionCalendar,
  countWorkingDays,
  firstWorkingDay,
  isWorkingDay,
  nextPortionRange,
  normalizeRestDays,
  nthWorkingDay,
  toggleRestDay,
} from './calendar.js';
import { addDays, weekday } from './dates.js';

// 16.09.2026 — среда.
const WED = '2026-09-16';
const FRI = 5;
const SAT = 6;
const SUN = 7;

describe('выходные', () => {
  it('сортирует и убирает повторы', () => {
    expect(normalizeRestDays([7, 5, 5])).toEqual([5, 7]);
    expect(normalizeRestDays([])).toEqual([]);
  });

  it('не больше двух и только 1–7', () => {
    expect(() => normalizeRestDays([1, 2, 3])).toThrow();
    expect(() => normalizeRestDays([0])).toThrow();
    expect(() => normalizeRestDays([8])).toThrow();
  });

  it('третий день выбрать нельзя, повторное нажатие снимает', () => {
    expect(toggleRestDay([], FRI)).toEqual([FRI]);
    expect(toggleRestDay([FRI], SUN)).toEqual([FRI, SUN]);
    expect(toggleRestDay([FRI, SUN], SAT)).toEqual([FRI, SUN]);
    expect(toggleRestDay([FRI, SUN], FRI)).toEqual([SUN]);
  });
});

describe('рабочие дни', () => {
  it('день недели', () => {
    expect(weekday(WED)).toBe(3);
    expect(isWorkingDay('2026-09-18', [FRI])).toBe(false);
    expect(isWorkingDay(WED, [FRI])).toBe(true);
  });

  it('первый рабочий день — сама дата или следующая после выходных', () => {
    expect(firstWorkingDay(WED, [])).toBe(WED);
    expect(firstWorkingDay('2026-09-19', [SAT, SUN])).toBe('2026-09-21');
  });

  it('считает включительно и учитывает выходные', () => {
    expect(countWorkingDays(WED, WED, [])).toBe(1);
    expect(countWorkingDays(WED, addDays(WED, 6), [])).toBe(7);
    expect(countWorkingDays(WED, addDays(WED, 6), [FRI])).toBe(6);
    expect(countWorkingDays(WED, addDays(WED, 29), [SAT, SUN])).toBe(22);
    expect(countWorkingDays(WED, addDays(WED, -1), [])).toBe(0);
    expect(countWorkingDays('2026-09-19', '2026-09-20', [SAT, SUN])).toBe(0);
  });

  it('совпадает с подсчётом по дням на длинных интервалах', () => {
    for (const rest of [[], [FRI], [SAT, SUN], [1, 4]]) {
      for (const length of [1, 5, 13, 100, 400]) {
        const end = addDays(WED, length - 1);
        let expected = 0;
        for (let i = 0; i < length; i++) if (isWorkingDay(addDays(WED, i), rest)) expected++;
        expect(countWorkingDays(WED, end, rest)).toBe(expected);
      }
    }
  });

  it('n-й рабочий день согласован с подсчётом', () => {
    for (const rest of [[], [FRI], [SAT, SUN]]) {
      for (const n of [1, 2, 5, 6, 7, 90, 365]) {
        const day = nthWorkingDay(WED, n, rest);
        expect(isWorkingDay(day, rest)).toBe(true);
        expect(countWorkingDays(WED, day, rest)).toBe(n);
      }
    }
    expect(nthWorkingDay('2026-09-19', 1, [SAT, SUN])).toBe('2026-09-21');
    expect(() => nthWorkingDay(WED, 0, [])).toThrow();
  });
});

describe('календарь порций', () => {
  it('следующая порция и конец плана', () => {
    expect(nextPortionRange(1, 448, 5)).toEqual({ from: 1, to: 5 });
    expect(nextPortionRange(446, 448, 5)).toEqual({ from: 446, to: 448 });
    expect(nextPortionRange(449, 448, 5)).toBeNull();
  });

  it('по одной порции на рабочий день, последняя короче', () => {
    const calendar = buildPortionCalendar({
      lineFrom: 11,
      lineTo: 23,
      unitsPerDay: 5,
      startDate: '2026-09-17',
      restDays: [FRI],
    });
    expect(calendar).toEqual([
      { seq: 1, date: '2026-09-17', from: 11, to: 15 },
      { seq: 2, date: '2026-09-19', from: 16, to: 20 },
      { seq: 3, date: '2026-09-20', from: 21, to: 23 },
    ]);
  });

  it('эталонная манзума: 448 бейтов по 5 — 90 порций', () => {
    const calendar = buildPortionCalendar({
      lineFrom: 1,
      lineTo: 448,
      unitsPerDay: 5,
      startDate: WED,
      restDays: [FRI],
    });
    expect(calendar).toHaveLength(90);
    expect(calendar.at(-1)).toMatchObject({ from: 446, to: 448 });
    expect(calendar.at(-1)?.date).toBe(nthWorkingDay(WED, 90, [FRI]));
    expect(calendar.every((p) => weekday(p.date) !== FRI)).toBe(true);
  });

  it('норма должна быть положительной', () => {
    expect(() =>
      buildPortionCalendar({
        lineFrom: 1,
        lineTo: 5,
        unitsPerDay: 0,
        startDate: WED,
        restDays: [],
      }),
    ).toThrow();
  });
});
