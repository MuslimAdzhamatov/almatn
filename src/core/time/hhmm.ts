export interface LocalTime {
  hour: number;
  minute: number;
}

export const MINUTES_PER_DAY = 24 * 60;

const HHMM = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;

/** Разбирает время «ЧЧ:ММ» (допускается «Ч:ММ» и точка вместо двоеточия). null — если формат неверный. */
export function parseHHmm(input: string): LocalTime | null {
  const match = HHMM.exec(input.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Как parseHHmm, но для значений из БД/конфига, где неверный формат — ошибка программы. */
export function requireHHmm(input: string): LocalTime {
  const time = parseHHmm(input);
  if (!time) throw new Error(`Некорректное время «${input}», ожидается ЧЧ:ММ`);
  return time;
}

/** Форматирует время в каноничный вид «ЧЧ:ММ», в котором оно хранится в БД. */
export function formatHHmm({ hour, minute }: LocalTime): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function toMinutes({ hour, minute }: LocalTime): number {
  return hour * 60 + minute;
}

/** Минуты от полуночи → время суток; значения вне [0, 24 ч) заворачиваются по кругу. */
export function fromMinutes(total: number): LocalTime {
  const minutes = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

/** Сдвигает время «ЧЧ:ММ» на заданное число минут по кругу суток. */
export function shiftHHmm(time: string, minutes: number): string {
  return formatHHmm(fromMinutes(toMinutes(requireHHmm(time)) + minutes));
}
