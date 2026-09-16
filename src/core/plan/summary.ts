import { buildPortionCalendar, normalizeRestDays } from './calendar.js';
import { addDays, type IsoDate } from './dates.js';
import { forecastLoad, LAST_REVIEW_OFFSET_DAYS, reviewEvents, type LoadForecast } from './load.js';
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
}

export interface PlanSummary extends Omit<PaceResult, 'ok'> {
  ok: true;
  totalUnits: number;
  restDays: number[];
  /** Дата последних повторов: последняя порция + 30 дней. */
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
  const load = forecastLoad(reviewEvents(calendar), pace.firstDate, pace.endDate);
  return {
    ...pace,
    totalUnits,
    restDays,
    lastReviewDate: addDays(pace.endDate, LAST_REVIEW_OFFSET_DAYS),
    load,
    overload: {
      unitsPerDay: pace.unitsPerDay > thresholds.maxUnitsPerDay,
      peak: load.peak > thresholds.maxPeakReview,
    },
  };
}
