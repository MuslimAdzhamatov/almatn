import { planningDayOf, type SlotSettings } from '../srs/slots.js';
import { addDays, diffDays, maxDate, type IsoDate } from './dates.js';

// Серия дней без долгов для /progress (CLAUDE.md, раздел 5.5).

export interface Duty {
  /** Когда дело стало положенным: срок повтора или выдача порции. */
  dueAt: Date;
  /** Когда сделано: подтверждение повтора или «Выучил»; null — ещё не сделано. */
  doneAt: Date | null;
}

/**
 * Сколько плановых суток подряд, считая назад от текущих, закончились без долга.
 * Сутки D «с долгом», если дело, положенное в D или раньше, не сделано до конца D.
 * Текущие сутки засчитываются, если сейчас долга нет. Считается не раньше since.
 */
export function cleanStreak(
  duties: readonly Duty[],
  now: Date,
  s: SlotSettings,
  since: IsoDate,
): number {
  const today = planningDayOf(now, s);
  const yesterday = addDays(today, -1);
  let lastDirty: IsoDate | null = null;
  let owedNow = false;
  for (const duty of duties) {
    if (duty.dueAt > now) continue;
    if (duty.doneAt === null) owedNow = true;
    const due = planningDayOf(duty.dueAt, s);
    // Последние сутки, которые закончились, пока дело не было сделано.
    const dirtyUntil =
      duty.doneAt === null ? yesterday : addDays(planningDayOf(duty.doneAt, s), -1);
    if (due <= dirtyUntil && (lastDirty === null || dirtyUntil > lastDirty)) lastDirty = dirtyUntil;
  }
  const firstClean = lastDirty === null ? since : maxDate(addDays(lastDirty, 1), since);
  const finished = Math.max(0, diffDays(firstClean, yesterday) + 1);
  return finished + (owedNow || today < since ? 0 : 1);
}
