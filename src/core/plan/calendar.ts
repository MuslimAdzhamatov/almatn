import { addDays, diffDays, weekday, type IsoDate } from './dates.js';

// Рабочие дни плана и календарь порций (CLAUDE.md, раздел 5.3).
// В выходной не приходит только новая порция; повторы идут по своим датам.

export const MAX_REST_DAYS = 2;

/** Проверяет выходные: 0–2 разных дня недели (1 = пн … 7 = вс); возвращает их по порядку. */
export function normalizeRestDays(days: readonly number[]): number[] {
  const unique = [...new Set(days)].sort((a, b) => a - b);
  if (unique.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
    throw new Error(`Некорректные выходные: ${days.join(', ')}`);
  }
  if (unique.length > MAX_REST_DAYS) {
    throw new Error(`Выходных не больше ${MAX_REST_DAYS}: ${days.join(', ')}`);
  }
  return unique;
}

/** Выбрать/снять выходной: третий день не добавляется. */
export function toggleRestDay(days: readonly number[], day: number): number[] {
  if (days.includes(day)) return days.filter((d) => d !== day);
  if (days.length >= MAX_REST_DAYS) return [...days];
  return normalizeRestDays([...days, day]);
}

export function isWorkingDay(date: IsoDate, restDays: readonly number[]): boolean {
  return !restDays.includes(weekday(date));
}

/** Первый рабочий день начиная с даты (включительно). */
export function firstWorkingDay(from: IsoDate, restDays: readonly number[]): IsoDate {
  let date = from;
  while (!isWorkingDay(date, restDays)) date = addDays(date, 1);
  return date;
}

/** Число рабочих дней в интервале [start, end] включительно; 0, если end раньше start. */
export function countWorkingDays(
  start: IsoDate,
  end: IsoDate,
  restDays: readonly number[],
): number {
  const days = diffDays(start, end) + 1;
  if (days <= 0) return 0;
  const weeks = Math.floor(days / 7);
  let count = weeks * (7 - restDays.length);
  for (let i = weeks * 7; i < days; i++) {
    if (isWorkingDay(addDays(start, i), restDays)) count++;
  }
  return count;
}

/** n-й рабочий день (n ≥ 1) начиная с даты start включительно. */
export function nthWorkingDay(start: IsoDate, n: number, restDays: readonly number[]): IsoDate {
  if (!Number.isInteger(n) || n < 1) throw new Error(`Номер рабочего дня должен быть ≥ 1: ${n}`);
  const perWeek = 7 - restDays.length;
  // Целые недели пропускаем сразу, остаток досчитываем по дням.
  const weeks = Math.floor((n - 1) / perWeek);
  let date = addDays(start, weeks * 7);
  let left = n - weeks * perWeek;
  for (;;) {
    if (isWorkingDay(date, restDays) && --left === 0) return date;
    date = addDays(date, 1);
  }
}

export interface UnitRange {
  from: number;
  to: number;
}

/** Диапазон следующей порции: с nextLine не больше unitsPerDay единиц; null — единицы кончились. */
export function nextPortionRange(
  nextLine: number,
  lineTo: number,
  unitsPerDay: number,
): UnitRange | null {
  if (nextLine > lineTo) return null;
  return { from: nextLine, to: Math.min(lineTo, nextLine + unitsPerDay - 1) };
}

export interface CalendarPortion extends UnitRange {
  seq: number;
  date: IsoDate;
}

export interface CalendarInput {
  lineFrom: number;
  lineTo: number;
  unitsPerDay: number;
  startDate: IsoDate;
  restDays: readonly number[];
}

/** Календарь плана: по одной порции на рабочий день, последняя может быть короче. */
export function buildPortionCalendar(input: CalendarInput): CalendarPortion[] {
  const { lineFrom, lineTo, unitsPerDay, restDays } = input;
  if (!Number.isInteger(unitsPerDay) || unitsPerDay < 1) {
    throw new Error(`Норма должна быть целым числом ≥ 1: ${unitsPerDay}`);
  }
  const portions: CalendarPortion[] = [];
  let date = firstWorkingDay(input.startDate, restDays);
  let range = nextPortionRange(lineFrom, lineTo, unitsPerDay);
  while (range) {
    portions.push({ seq: portions.length + 1, date, ...range });
    date = firstWorkingDay(addDays(date, 1), restDays);
    range = nextPortionRange(range.to + 1, lineTo, unitsPerDay);
  }
  return portions;
}
