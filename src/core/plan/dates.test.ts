import { describe, expect, it } from 'vitest';
import {
  addDays,
  dbDateToIso,
  diffDays,
  formatUserDate,
  isIsoDate,
  isoToDbDate,
  localDate,
  parseUserDate,
} from './dates.js';

describe('даты плана', () => {
  it('арифметика не зависит от перехода на летнее время', () => {
    expect(addDays('2026-10-24', 2)).toBe('2026-10-26');
    expect(addDays('2027-03-27', 2)).toBe('2027-03-29');
    expect(diffDays('2026-10-24', '2026-10-26')).toBe(2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('местная дата зависит от пояса', () => {
    const now = new Date('2026-09-16T22:30:00Z');
    expect(localDate(now, 'Europe/London')).toBe('2026-09-16');
    expect(localDate(now, 'Europe/Moscow')).toBe('2026-09-17');
    expect(localDate(now, 'America/New_York')).toBe('2026-09-16');
  });

  it.each([
    ['30.12.2026', '2026-12-30'],
    ['1.10.2026', '2026-10-01'],
    [' 01.1.2027 ', '2027-01-01'],
    ['29.02.2027', null],
    ['2026-12-30', null],
    ['30.12.26', null],
  ])('ввод «%s» → %s', (input, expected) => {
    expect(parseUserDate(input)).toBe(expected);
  });

  it('показ, проверка и поле @db.Date', () => {
    expect(formatUserDate('2026-10-01')).toBe('01.10.2026');
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(() => addDays('30.12.2026', 1)).toThrow();
    expect(isoToDbDate('2026-10-01').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(dbDateToIso(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01');
  });
});
