import { estimateEndDate } from '../scheduler/rules.js';
import { countWorkingDays } from './calendar.js';
import { addDays, maxDate, type IsoDate } from './dates.js';

// «Успеть к сроку» / «Сдвинуть срок» (CLAUDE.md, раздел 5.2): после закрытия долга оставшиеся
// единицы пересчитываются на рабочие дни начиная со следующих плановых суток.

export interface PaceCheckInput {
  /** Текущие плановые сутки (порция этих суток, если выдана, уже не входит в остаток). */
  today: IsoDate;
  remainingUnits: number;
  unitsPerDay: number;
  restDays: readonly number[];
  startDate: IsoDate;
  paceMode: 'deadline' | 'per_day';
  deadlineDate: IsoDate | null;
  estimatedEndDate: IsoDate | null;
}

export type PaceCheck =
  /** Успеваем; endDate — расчётная дата окончания (могла сдвинуться в пределах срока). */
  | { kind: 'on_track'; endDate: IsoDate }
  /** Режим «по количеству в день»: дата окончания сдвинулась. */
  | { kind: 'shifted'; endDate: IsoDate; previous: IsoDate }
  /** Режим «по сроку»: с прежней нормой не успеть — выбор пользователя. */
  | {
      kind: 'behind';
      deadline: IsoDate;
      /** «Сдвинуть срок»: прежняя норма, новая дата. */
      shiftEndDate: IsoDate;
      /** «Успеть к сроку»: новая норма; null — до срока не осталось рабочих дней. */
      catchUpUnitsPerDay: number | null;
      catchUpEndDate: IsoDate | null;
      /** Норма выросла бы больше чем вдвое (или успеть нельзя) — советуем сдвинуть срок. */
      adviseShift: boolean;
    };

const endWith = (input: PaceCheckInput, unitsPerDay: number) =>
  estimateEndDate(input.today, input.remainingUnits, unitsPerDay, input.restDays, input.startDate);

export function checkPace(input: PaceCheckInput): PaceCheck {
  const endDate = endWith(input, input.unitsPerDay);
  if (input.remainingUnits <= 0) return { kind: 'on_track', endDate };

  if (input.paceMode === 'per_day') {
    const previous = input.estimatedEndDate;
    return previous !== null && endDate > previous
      ? { kind: 'shifted', endDate, previous }
      : { kind: 'on_track', endDate };
  }

  const deadline = input.deadlineDate ?? input.estimatedEndDate;
  if (deadline === null || endDate <= deadline) return { kind: 'on_track', endDate };

  const from = maxDate(addDays(input.today, 1), input.startDate);
  const days = countWorkingDays(from, deadline, input.restDays);
  const catchUp = days > 0 ? Math.ceil(input.remainingUnits / days) : null;
  return {
    kind: 'behind',
    deadline,
    shiftEndDate: endDate,
    catchUpUnitsPerDay: catchUp,
    catchUpEndDate: catchUp === null ? null : endWith(input, catchUp),
    adviseShift: catchUp === null || catchUp > 2 * input.unitsPerDay,
  };
}
