import { formatHHmm, requireHHmm, shiftHHmm, toMinutes } from './hhmm.js';

export type NightPolicy = 'keep' | 'move';

export interface QuietHours {
  start: string;
  end: string;
}

/** Попадает ли время в тихие часы [start, end) — в том числе через полночь. start = end — тихих часов нет. */
export function isQuietTime(time: string, quiet: QuietHours): boolean {
  const t = toMinutes(requireHHmm(time));
  const start = toMinutes(requireHHmm(quiet.start));
  const end = toMinutes(requireHHmm(quiet.end));
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export interface ScheduleSettings {
  dailySendTime: string;
  eveningReminderTime: string;
  nightStart: string;
  nightEnd: string;
  nightPolicy: NightPolicy;
}

export interface ScheduleEntry {
  /** Время по расписанию. */
  planned: string;
  /** Попадает в тихие часы. */
  atNight: boolean;
  /** Когда сообщение придёт с учётом nightPolicy. */
  actual: string;
}

export interface DailySchedule {
  /** Основной слот: новая порция и повторы +1д/+3д/+2нед/+1мес. */
  newPortion: ScheduleEntry;
  /** Второй слот (+12 часов): повтор через 12 часов. */
  secondSlot: ScheduleEntry;
  eveningReminder: ScheduleEntry;
  hasNightEntries: boolean;
}

type NightSettings = Pick<ScheduleSettings, 'nightStart' | 'nightEnd' | 'nightPolicy'>;

export function scheduleEntry(time: string, night: NightSettings): ScheduleEntry {
  const planned = formatHHmm(requireHHmm(time));
  const atNight = isQuietTime(planned, { start: night.nightStart, end: night.nightEnd });
  const actual =
    atNight && night.nightPolicy === 'move' ? formatHHmm(requireHHmm(night.nightEnd)) : planned;
  return { planned, atNight, actual };
}

/** Суточное расписание пользователя (раздел 5.4, шаг 3) — для показа при настройке. */
export function buildDailySchedule(settings: ScheduleSettings): DailySchedule {
  const newPortion = scheduleEntry(settings.dailySendTime, settings);
  const secondSlot = scheduleEntry(shiftHHmm(settings.dailySendTime, 12 * 60), settings);
  const eveningReminder = scheduleEntry(settings.eveningReminderTime, settings);
  return {
    newPortion,
    secondSlot,
    eveningReminder,
    hasNightEntries: [newPortion, secondSlot, eveningReminder].some((entry) => entry.atNight),
  };
}
