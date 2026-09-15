export interface LocalTime {
  hour: number;
  minute: number;
}

const HHMM = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;

/** Разбирает время «ЧЧ:ММ» (допускается «Ч:ММ» и точка вместо двоеточия). null — если формат неверный. */
export function parseHHmm(input: string): LocalTime | null {
  const match = HHMM.exec(input.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Форматирует время в каноничный вид «ЧЧ:ММ», в котором оно хранится в БД. */
export function formatHHmm({ hour, minute }: LocalTime): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
