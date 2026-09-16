import { countWorkingDays, firstWorkingDay, nthWorkingDay } from './calendar.js';
import { addDays, isIsoDate, type IsoDate } from './dates.js';

// Темп плана (CLAUDE.md, раздел 5.3): «по сроку» → норма в день, «по количеству в день» → дата окончания.

export const DAYS_IN_MONTH = 30;

export type DeadlineInput =
  | { kind: 'days'; value: number }
  | { kind: 'months'; value: number }
  | { kind: 'date'; date: IsoDate };

export type PaceInput =
  { mode: 'deadline'; deadline: DeadlineInput } | { mode: 'per_day'; unitsPerDay: number };

/** Строка для `Plan.deadlineInput`: days:N | months:N | date:YYYY-MM-DD. */
export function encodeDeadlineInput(input: DeadlineInput): string {
  return input.kind === 'date' ? `date:${input.date}` : `${input.kind}:${input.value}`;
}

export function decodeDeadlineInput(value: string): DeadlineInput | null {
  const [kind, raw] = value.split(':', 2);
  if (kind === 'date') return raw && isIsoDate(raw) ? { kind, date: raw } : null;
  if (kind !== 'days' && kind !== 'months') return null;
  const number = Number(raw);
  return Number.isInteger(number) && number >= 1 ? { kind, value: number } : null;
}

/** Последний день срока: N дней — включая дату начала; месяц = 30 дней. */
export function resolveDeadline(startDate: IsoDate, input: DeadlineInput): IsoDate {
  switch (input.kind) {
    case 'days':
      return addDays(startDate, input.value - 1);
    case 'months':
      return addDays(startDate, input.value * DAYS_IN_MONTH - 1);
    case 'date':
      return input.date;
  }
}

export interface PaceRequest {
  totalUnits: number;
  startDate: IsoDate;
  restDays: readonly number[];
  pace: PaceInput;
}

export interface PaceResult {
  ok: true;
  unitsPerDay: number;
  /** Сколько порций (рабочих дней заучивания). */
  portions: number;
  /** Дата первой порции (первый рабочий день с даты начала). */
  firstDate: IsoDate;
  /** Дата последней порции. */
  endDate: IsoDate;
  /** Срок, указанный пользователем (режим «по сроку»). */
  deadlineDate: IsoDate | null;
  /** Заучивание закончится раньше указанного срока. */
  endsEarly: boolean;
}

export type PaceError = { ok: false; reason: 'deadline_before_start' | 'no_working_days' };

export function computePace(request: PaceRequest): PaceResult | PaceError {
  const { totalUnits, startDate, restDays, pace } = request;
  if (!Number.isInteger(totalUnits) || totalUnits < 1) {
    throw new Error(`Число единиц должно быть ≥ 1: ${totalUnits}`);
  }
  const firstDate = firstWorkingDay(startDate, restDays);

  let unitsPerDay: number;
  let deadlineDate: IsoDate | null = null;
  if (pace.mode === 'deadline') {
    deadlineDate = resolveDeadline(startDate, pace.deadline);
    if (deadlineDate < startDate) return { ok: false, reason: 'deadline_before_start' };
    const workingDays = countWorkingDays(startDate, deadlineDate, restDays);
    if (workingDays === 0) return { ok: false, reason: 'no_working_days' };
    unitsPerDay = Math.ceil(totalUnits / workingDays);
  } else {
    if (!Number.isInteger(pace.unitsPerDay) || pace.unitsPerDay < 1) {
      throw new Error(`Норма должна быть целым числом ≥ 1: ${pace.unitsPerDay}`);
    }
    unitsPerDay = Math.min(pace.unitsPerDay, totalUnits);
  }

  const portions = Math.ceil(totalUnits / unitsPerDay);
  const endDate = nthWorkingDay(startDate, portions, restDays);
  return {
    ok: true,
    unitsPerDay,
    portions,
    firstDate,
    endDate,
    deadlineDate,
    endsEarly: deadlineDate !== null && endDate < deadlineDate,
  };
}
