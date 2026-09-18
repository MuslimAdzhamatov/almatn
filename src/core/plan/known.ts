import { buildPortionCalendar, type CalendarPortion } from './calendar.js';
import type { IsoDate } from './dates.js';

// «Уже знаю» (CLAUDE.md, раздел 5.3): часть текста пользователь знал ещё до плана.
// Такие единицы не выдаются новыми порциями, но повторяются — тем же темпом и по тем же
// рабочим дням, что и заучивание, с укороченной цепочкой (без +12 ч, см. KNOWN_REVIEW_STAGES).

export interface KnownRange {
  lineFrom: number;
  lineTo: number;
}

/**
 * Номер единицы, до которой текст уже известен: целое из [lineFrom, lineTo − 1].
 * Последнюю единицу диапазона знать нельзя — плану нечего было бы учить.
 */
export function parseKnownUpTo(input: string, lineFrom: number, lineTo: number): number | null {
  const value = Number(input.trim());
  if (!Number.isInteger(value)) return null;
  return value >= lineFrom && value <= lineTo - 1 ? value : null;
}

/** Диапазоны известных единиц по рабочим дням плана; пустой массив — известного нет. */
export function knownCalendar(
  known: KnownRange | null,
  unitsPerDay: number,
  startDate: IsoDate,
  restDays: readonly number[],
): CalendarPortion[] {
  if (!known || known.lineTo < known.lineFrom) return [];
  return buildPortionCalendar({
    lineFrom: known.lineFrom,
    lineTo: known.lineTo,
    unitsPerDay,
    startDate,
    restDays,
  });
}
