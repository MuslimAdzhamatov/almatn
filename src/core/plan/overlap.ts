import { buildPortionCalendar } from './calendar.js';
import { addDays, maxDate, type IsoDate } from './dates.js';
import { dailyLoad, reviewEvents, type LoadEvent } from './load.js';

// Наложение нового плана на уже идущие (CLAUDE.md, раздел 4.2): сколько повторов уже запланировано.

/** Сколько дней вперёд показывать уже запланированные повторы. */
export const OVERLAP_WINDOW_DAYS = 14;

export interface OpenPlanState {
  nextLine: number;
  lineTo: number;
  unitsPerDay: number;
  startDate: IsoDate;
  restDays: readonly number[];
}

/**
 * Повторы, которые ещё породят невыданные порции плана: календарь от nextLine,
 * начиная с даты начала или с завтрашнего дня (сегодняшняя порция могла уже прийти).
 */
export function remainingPlanEvents(plan: OpenPlanState, today: IsoDate): LoadEvent[] {
  if (plan.nextLine > plan.lineTo) return [];
  return reviewEvents(
    buildPortionCalendar({
      lineFrom: plan.nextLine,
      lineTo: plan.lineTo,
      unitsPerDay: plan.unitsPerDay,
      startDate: maxDate(plan.startDate, addDays(today, 1)),
      restDays: plan.restDays,
    }),
  );
}

export interface OverlapForecast {
  /** Единиц повтора по другим планам за ближайшие дни [today, today + окно). */
  upcomingTotal: number;
  upcomingPeak: number;
  /** Пик повторов вместе с новым планом за период его заучивания. */
  combinedPeak: number;
}

export function forecastOverlap(
  existing: readonly LoadEvent[],
  added: readonly LoadEvent[],
  today: IsoDate,
  period: { from: IsoDate; to: IsoDate },
): OverlapForecast {
  const upcoming = dailyLoad(existing, today, addDays(today, OVERLAP_WINDOW_DAYS - 1));
  const combined = dailyLoad([...existing, ...added], period.from, period.to);
  return {
    upcomingTotal: upcoming.reduce((sum, units) => sum + units, 0),
    upcomingPeak: Math.max(0, ...upcoming),
    combinedPeak: Math.max(0, ...combined),
  };
}
