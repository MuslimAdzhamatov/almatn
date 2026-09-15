import { describe, expect, it } from 'vitest';
import { formatHHmm, fromMinutes, parseHHmm, requireHHmm, shiftHHmm } from './hhmm.js';

describe('parseHHmm', () => {
  it.each([
    ['06:00', { hour: 6, minute: 0 }],
    ['6:05', { hour: 6, minute: 5 }],
    ['23:59', { hour: 23, minute: 59 }],
    ['00:00', { hour: 0, minute: 0 }],
    [' 14.30 ', { hour: 14, minute: 30 }],
  ])('разбирает %j', (input, expected) => {
    expect(parseHHmm(input)).toEqual(expected);
  });

  it.each(['24:00', '12:60', '1230', '12:5', 'ab:cd', '', '-1:00'])('отклоняет %j', (input) => {
    expect(parseHHmm(input)).toBeNull();
  });
});

describe('requireHHmm', () => {
  it('бросает ошибку на неверном формате', () => {
    expect(() => requireHHmm('25:00')).toThrow('ЧЧ:ММ');
  });
});

describe('formatHHmm', () => {
  it('добавляет ведущие нули', () => {
    expect(formatHHmm({ hour: 6, minute: 5 })).toBe('06:05');
  });

  it('обратим с parseHHmm', () => {
    expect(formatHHmm(parseHHmm('9:30')!)).toBe('09:30');
  });
});

describe('fromMinutes / shiftHHmm', () => {
  it('заворачивает время по кругу суток', () => {
    expect(fromMinutes(24 * 60 + 15)).toEqual({ hour: 0, minute: 15 });
    expect(fromMinutes(-30)).toEqual({ hour: 23, minute: 30 });
  });

  it.each([
    ['06:00', 720, '18:00'],
    ['14:00', 720, '02:00'],
    ['23:30', 720, '11:30'],
    ['00:10', -20, '23:50'],
  ])('%s сдвинутое на %i мин → %s', (time, minutes, expected) => {
    expect(shiftHHmm(time, minutes)).toBe(expected);
  });
});
