import { buildPortionCalendar, normalizeRestDays } from './calendar.js';
import { addDays, maxDate, type IsoDate } from './dates.js';
import { knownCalendar, type KnownRange } from './known.js';
import {
  forecastLoad,
  KNOWN_REVIEW_OFFSET_DAYS,
  LAST_REVIEW_OFFSET_DAYS,
  reviewEvents,
  type LoadForecast,
} from './load.js';
import { computePace, type PaceError, type PaceInput, type PaceResult } from './pace.js';

// Сводка плана для подтверждения (CLAUDE.md, раздел 5.3): норма, даты, нагрузка, предупреждение о перегрузке.

export interface OverloadThresholds {
  /** Новых единиц в день больше этого числа — предупреждение. */
  maxUnitsPerDay: number;
  /** Повтор на пике больше этого числа — предупреждение. */
  maxPeakReview: number;
}

export interface PlanDraft {
  lineFrom: number;
  lineTo: number;
  startDate: IsoDate;
  restDays: readonly number[];
  pace: PaceInput;
  /** Единицы, которые пользователь знал до плана: не выдаются, но повторяются. */
  known?: KnownRange | null;
}

export interface PlanSummary extends Omit<PaceResult, 'ok'> {
  ok: true;
  totalUnits: number;
  /** Сколько единиц идёт только на повторение («Уже знаю»). */
  knownUnits: number;
  restDays: number[];
  /** Дата последних повторов: последняя порция (или известная единица) + 30 дней. */
  lastReviewDate: IsoDate;
  load: LoadForecast;
  overload: { unitsPerDay: boolean; peak: boolean };
}

export function summarizePlan(
  draft: PlanDraft,
  thresholds: OverloadThresholds,
): PlanSummary | PaceError {
  if (draft.lineFrom < 1 || draft.lineTo < draft.lineFrom) {
    throw new Error(`Некорректный диапазон: ${draft.lineFrom}–${draft.lineTo}`);
  }
  const restDays = normalizeRestDays(draft.restDays);
  const totalUnits = draft.lineTo - draft.lineFrom + 1;
  const pace = computePace({ totalUnits, startDate: draft.startDate, restDays, pace: draft.pace });
  if (!pace.ok) return pace;

  const calendar = buildPortionCalendar({
    lineFrom: draft.lineFrom,
    lineTo: draft.lineTo,
    unitsPerDay: pace.unitsPerDay,
    startDate: draft.startDate,
    restDays,
  });
  // Известные единицы идут тем же темпом рядом с новыми и добавляют повторов.
  const known = knownCalendar(draft.known ?? null, pace.unitsPerDay, draft.startDate, restDays);
  const events = [
    ...reviewEvents(calendar),
    ...reviewEvents(known, KNOWN_REVIEW_OFFSET_DAYS),
  ];
  const lastDate = maxDate(pace.endDate, known.at(-1)?.date ?? pace.endDate);
  const load = forecastLoad(events, pace.firstDate, lastDate);
  return {
    ...pace,
    totalUnits,
    knownUnits: known.reduce((sum, portion) => sum + portion.to - portion.from + 1, 0),
    restDays,
    lastReviewDate: addDays(lastDate, LAST_REVIEW_OFFSET_DAYS),
    load,
    overload: {
      unitsPerDay: pace.unitsPerDay > thresholds.maxUnitsPerDay,
      peak: load.peak > thresholds.maxPeakReview,
    },
  };
}
