import { addDays, diffDays, localDate, type IsoDate } from './dates.js';

// Пауза (CLAUDE.md, раздел 5.5): длительность, предупреждение накануне, сдвиг сроков плана.

const DAY = 24 * 60 * 60 * 1000;

export const PAUSE_PRESETS = { d1: 1, w1: 7, w2: 14, w3: 21, m1: 30 } as const;
export type PausePreset = keyof typeof PAUSE_PRESETS;

export const isPausePreset = (value: string): value is PausePreset => value in PAUSE_PRESETS;

/** Дата, в основной слот которой пауза закончится. */
export function pauseEndDate(today: IsoDate, preset: PausePreset): IsoDate {
  return addDays(today, PAUSE_PRESETS[preset]);
}

/** «Завтра продолжаем»: пауза дольше 2 дней и до конца меньше суток. */
export function pauseWarningDue(pausedFrom: Date, pausedUntil: Date, now: Date): boolean {
  const length = pausedUntil.getTime() - pausedFrom.getTime();
  const left = pausedUntil.getTime() - now.getTime();
  return length > 2 * DAY && left > 0 && left <= DAY;
}

/** На сколько дней сдвинуть сроки: календарные дни паузы по местному времени. */
export function pauseShiftDays(pausedFrom: Date, resumedAt: Date, timezone: string): number {
  return Math.max(0, diffDays(localDate(pausedFrom, timezone), localDate(resumedAt, timezone)));
}

export const shiftDate = (date: IsoDate | null, days: number): IsoDate | null =>
  date === null || days === 0 ? date : addDays(date, days);
