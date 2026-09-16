import { firstWorkingDay, isWorkingDay, nthWorkingDay } from '../plan/calendar.js';
import { addDays, maxDate, type IsoDate } from '../plan/dates.js';
import { localMoment, mainSlotOn, planningDayOf, type SlotSettings } from '../srs/slots.js';
import { requireHHmm, toMinutes } from '../time/hhmm.js';

// Строгий режим (CLAUDE.md, раздел 5.2): долг, вечернее напоминание, «выдать сейчас или в слот».

const HOUR = 60 * 60 * 1000;
/** Вечернее напоминание должно отстоять от основных слотов хотя бы на 3 часа. */
export const EVENING_GAP_MS = 3 * HOUR;

export interface ReviewState {
  dueAt: Date;
  status: 'pending' | 'sent' | 'confirmed' | 'missed' | 'cancelled';
}

export interface DebtInput {
  /** Последняя выданная порция не отмечена «Выучил». */
  unlearnedPortion: boolean;
  /** Повторы выданных порций текста (без learn_reminder). */
  reviews: readonly ReviewState[];
}

/** Долг по тексту: невыученная порция или наступивший неподтверждённый повтор. */
export function hasDebt(now: Date, input: DebtInput): boolean {
  return (
    input.unlearnedPortion ||
    input.reviews.some(
      (r) => r.dueAt <= now && r.status !== 'confirmed' && r.status !== 'cancelled',
    )
  );
}

export interface ScheduleRules extends SlotSettings {
  eveningReminderTime: string;
}

/**
 * Момент вечернего напоминания в плановые сутки day или null, если оно ближе 3 часов
 * к основному слоту этих или следующих суток.
 */
export function eveningReminderAt(day: IsoDate, s: ScheduleRules): Date | null {
  const main = mainSlotOn(day, s);
  const nextMain = mainSlotOn(addDays(day, 1), s);
  const sameDate =
    toMinutes(requireHHmm(s.eveningReminderTime)) > toMinutes(requireHHmm(s.dailySendTime));
  const evening = localMoment(sameDate ? day : addDays(day, 1), s.eveningReminderTime, s.timezone);
  const ok =
    evening.getTime() - main.getTime() >= EVENING_GAP_MS &&
    nextMain.getTime() - evening.getTime() >= EVENING_GAP_MS;
  return ok ? evening : null;
}

/** До какого момента плановых суток новая порция приходит сразу, а не в следующий слот. */
export function immediateThreshold(day: IsoDate, s: ScheduleRules): Date {
  return (
    eveningReminderAt(day, s) ?? new Date(mainSlotOn(addDays(day, 1), s).getTime() - EVENING_GAP_MS)
  );
}

export interface IssueInput {
  now: Date;
  rules: ScheduleRules;
  startDate: IsoDate;
  restDays: readonly number[];
  /** Когда выдана последняя порция плана. */
  lastPortionSentAt: Date | null;
  debt: boolean;
  /** Остались невыданные единицы. */
  hasUnits: boolean;
}

export type IssueDecision =
  | { kind: 'now' }
  /** Следующая порция — в основной слот этого момента (если к тому времени не будет долга). */
  | { kind: 'at'; at: Date }
  | { kind: 'blocked'; reason: 'debt' | 'done' };

/**
 * Правило «выдать сейчас или в слот»: одна порция за плановые сутки, только в рабочий день
 * не раньше даты начала и раньше порога; иначе — основной слот ближайшего подходящего дня.
 */
export function decideIssue(input: IssueInput): IssueDecision {
  const { now, rules, restDays } = input;
  if (!input.hasUnits) return { kind: 'blocked', reason: 'done' };
  if (input.debt) return { kind: 'blocked', reason: 'debt' };

  const day = planningDayOf(now, rules);
  const issuedToday =
    input.lastPortionSentAt !== null && planningDayOf(input.lastPortionSentAt, rules) === day;
  if (
    !issuedToday &&
    day >= input.startDate &&
    isWorkingDay(day, restDays) &&
    now < immediateThreshold(day, rules)
  ) {
    return { kind: 'now' };
  }
  const next = firstWorkingDay(maxDate(addDays(day, 1), input.startDate), restDays);
  return { kind: 'at', at: mainSlotOn(next, rules) };
}

export interface UnitRef {
  lineNumber: number;
  skipped: boolean;
}

/**
 * Следующая порция: первые unitsPerDay непропущенных единиц начиная с from (единицы — по порядку).
 * Диапазон может включать пропущенные единицы внутри — они не показываются и не повторяются.
 */
export function pickPortion(
  units: readonly UnitRef[],
  from: number,
  lineTo: number,
  unitsPerDay: number,
): { lineStart: number; lineEnd: number; count: number } | null {
  const picked = units
    .filter((u) => !u.skipped && u.lineNumber >= from && u.lineNumber <= lineTo)
    .sort((a, b) => a.lineNumber - b.lineNumber)
    .slice(0, unitsPerDay);
  const first = picked[0];
  const last = picked.at(-1);
  if (!first || !last) return null;
  return { lineStart: first.lineNumber, lineEnd: last.lineNumber, count: picked.length };
}

/**
 * Дата окончания заучивания: оставшиеся единицы по норме, по порции на рабочий день начиная со
 * следующих плановых суток; если единиц не осталось — дата последней выданной порции.
 */
export function estimateEndDate(
  today: IsoDate,
  remainingUnits: number,
  unitsPerDay: number,
  restDays: readonly number[],
  startDate: IsoDate,
): IsoDate {
  if (remainingUnits <= 0) return today;
  const portions = Math.ceil(remainingUnits / unitsPerDay);
  return nthWorkingDay(maxDate(addDays(today, 1), startDate), portions, restDays);
}
