import { describe, expect, it } from 'vitest';
import type { IsoDate } from './dates.js';
import { knownCalendar, parseKnownUpTo } from './known.js';

describe('parseKnownUpTo', () => {
  it('принимает номер внутри диапазона', () => {
    expect(parseKnownUpTo('100', 1, 448)).toBe(100);
    expect(parseKnownUpTo(' 7 ', 1, 448)).toBe(7);
  });

  it('требует оставить плану хотя бы одну единицу', () => {
    expect(parseKnownUpTo('448', 1, 448)).toBeNull();
    expect(parseKnownUpTo('447', 1, 448)).toBe(447);
  });

  it('не пускает номер до начала диапазона', () => {
    expect(parseKnownUpTo('9', 10, 200)).toBeNull();
    expect(parseKnownUpTo('10', 10, 200)).toBe(10);
  });

  it('отвергает не числа и дроби', () => {
    for (const input of ['', 'сто', '12,5', '12.5', '-3']) {
      expect(parseKnownUpTo(input, 1, 448)).toBeNull();
    }
  });
});

describe('knownCalendar', () => {
  const monday = '2026-09-21' as IsoDate;

  it('раскладывает известные единицы по рабочим дням тем же темпом', () => {
    const calendar = knownCalendar({ lineFrom: 1, lineTo: 12 }, 5, monday, []);
    expect(calendar).toEqual([
      { seq: 1, from: 1, to: 5, date: '2026-09-21' },
      { seq: 2, from: 6, to: 10, date: '2026-09-22' },
      { seq: 3, from: 11, to: 12, date: '2026-09-23' },
    ]);
  });

  it('пропускает выходные, как и заучивание', () => {
    const calendar = knownCalendar({ lineFrom: 1, lineTo: 4 }, 2, monday, [2]);
    expect(calendar.map((p) => p.date)).toEqual(['2026-09-21', '2026-09-23']);
  });

  it('без известных единиц календарь пуст', () => {
    expect(knownCalendar(null, 5, monday, [])).toEqual([]);
    expect(knownCalendar({ lineFrom: 5, lineTo: 4 }, 5, monday, [])).toEqual([]);
  });
});
