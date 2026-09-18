import type { CalendarPortion } from './calendar.js';
import { addDays, diffDays, type IsoDate } from './dates.js';

// Прогноз нагрузки на повторы (CLAUDE.md, раздел 5.3). Предполагается, что порция выучена в день выдачи
// и «Выучил» округлено к основному слоту этого дня. Тогда +12 ч — второй слот тех же плановых суток,
// остальные этапы — тот же слот через 1/3/14/30 дней. Выходные повторы не сдвигают.

export const REVIEW_OFFSET_DAYS = [0, 1, 3, 14, 30] as const;

/** Уже известные единицы повторяются без +12 ч — первый повтор на следующий день. */
export const KNOWN_REVIEW_OFFSET_DAYS: readonly number[] = [1, 3, 14, 30];

/** Через сколько дней после последней порции приходят последние повторы (+1 месяц). */
export const LAST_REVIEW_OFFSET_DAYS: number = REVIEW_OFFSET_DAYS[4];

export interface LoadEvent {
  date: IsoDate;
  units: number;
}

/** Повторы, которые породит календарь порций: по событию на каждый этап каждой порции. */
export function reviewEvents(
  calendar: readonly CalendarPortion[],
  offsets: readonly number[] = REVIEW_OFFSET_DAYS,
): LoadEvent[] {
  return calendar.flatMap((portion) =>
    offsets.map((offset) => ({
      date: addDays(portion.date, offset),
      units: portion.to - portion.from + 1,
    })),
  );
}

/** Сколько единиц повторять в каждый день интервала [from, to] включительно (массив по дням). */
export function dailyLoad(events: readonly LoadEvent[], from: IsoDate, to: IsoDate): number[] {
  const days = diffDays(from, to) + 1;
  const load = Array.from({ length: Math.max(days, 0) }, () => 0);
  for (const event of events) {
    const index = diffDays(from, event.date);
    if (index >= 0 && index < days) load[index] = (load[index] ?? 0) + event.units;
  }
  return load;
}

export interface LoadForecast {
  /** «Обычно N–M в день»: квартили нагрузки за период заучивания. */
  typicalLow: number;
  typicalHigh: number;
  peak: number;
  peakDate: IsoDate | null;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.round((sorted.length - 1) * q)] ?? 0;
}

/**
 * Нагрузка за период [from, to]: «обычно» — межквартильный размах по всем дням периода
 * (с выходными и днями без повторов), пик — максимум.
 */
export function forecastLoad(
  events: readonly LoadEvent[],
  from: IsoDate,
  to: IsoDate,
): LoadForecast {
  const load = dailyLoad(events, from, to);
  let peak = 0;
  let peakDate: IsoDate | null = null;
  load.forEach((units, index) => {
    if (units > peak) {
      peak = units;
      peakDate = addDays(from, index);
    }
  });
  const sorted = [...load].sort((a, b) => a - b);
  return {
    typicalLow: quantile(sorted, 0.25),
    typicalHigh: quantile(sorted, 0.75),
    peak,
    peakDate,
  };
}
