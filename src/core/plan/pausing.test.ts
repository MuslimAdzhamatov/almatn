import { describe, expect, it } from 'vitest';
import {
  isPausePreset,
  pauseEndDate,
  pauseShiftDays,
  pauseWarningDue,
  shiftDate,
} from './pausing.js';

const at = (s: string) => new Date(s);

describe('пауза', () => {
  it('длительность', () => {
    expect(pauseEndDate('2026-09-16', 'd1')).toBe('2026-09-17');
    expect(pauseEndDate('2026-09-16', 'w3')).toBe('2026-10-07');
    expect(pauseEndDate('2026-09-16', 'm1')).toBe('2026-10-16');
    expect(isPausePreset('w2')).toBe(true);
    expect(isPausePreset('x')).toBe(false);
  });

  it('предупреждение накануне — только для паузы дольше 2 дней', () => {
    const from = at('2026-09-16T10:00:00Z');
    const until = at('2026-09-23T03:00:00Z');
    expect(pauseWarningDue(from, until, at('2026-09-22T02:59:00Z'))).toBe(false);
    expect(pauseWarningDue(from, until, at('2026-09-22T03:00:00Z'))).toBe(true);
    expect(pauseWarningDue(from, until, until)).toBe(false);
    expect(pauseWarningDue(from, at('2026-09-18T03:00:00Z'), at('2026-09-17T12:00:00Z'))).toBe(
      false,
    );
  });

  it('сдвиг сроков — календарные дни по местному времени', () => {
    expect(
      pauseShiftDays(at('2026-09-16T20:30:00Z'), at('2026-09-23T03:00:00Z'), 'Europe/Moscow'),
    ).toBe(7);
    expect(pauseShiftDays(at('2026-09-16T10:00:00Z'), at('2026-09-16T12:00:00Z'), 'UTC')).toBe(0);
    expect(shiftDate('2026-09-30', 6)).toBe('2026-10-06');
    expect(shiftDate(null, 6)).toBeNull();
  });
});
