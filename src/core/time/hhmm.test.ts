import { describe, expect, it } from 'vitest';
import { formatHHmm, parseHHmm } from './hhmm.js';

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

describe('formatHHmm', () => {
  it('добавляет ведущие нули', () => {
    expect(formatHHmm({ hour: 6, minute: 5 })).toBe('06:05');
  });

  it('обратим с parseHHmm', () => {
    expect(formatHHmm(parseHHmm('9:30')!)).toBe('09:30');
  });
});
