import { DateTime } from 'luxon';

// Календарные даты плана (CLAUDE.md, раздел 5.3). Дата — строка «ГГГГ-ММ-ДД» без времени и пояса:
// арифметика идёт в UTC, поэтому переход на летнее время на даты не влияет.

export type IsoDate = string;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const USER_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;

function toDateTime(date: IsoDate): DateTime {
  const value = ISO.test(date) ? DateTime.fromISO(date, { zone: 'utc' }) : null;
  if (!value?.isValid) throw new Error(`Некорректная дата «${date}», ожидается ГГГГ-ММ-ДД`);
  return value;
}

function toIso(value: DateTime): IsoDate {
  return value.toISODate() as IsoDate;
}

export function isIsoDate(date: string): boolean {
  return ISO.test(date) && DateTime.fromISO(date, { zone: 'utc' }).isValid;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return toIso(toDateTime(date).plus({ days }));
}

/** Сколько дней от a до b (b − a). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round(toDateTime(b).diff(toDateTime(a), 'days').days);
}

/** День недели: 1 = пн … 7 = вс. */
export function weekday(date: IsoDate): number {
  return toDateTime(date).weekday;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** Местная дата пользователя в момент now. */
export function localDate(now: Date, timezone: string): IsoDate {
  return toIso(DateTime.fromJSDate(now, { zone: timezone }));
}

/** Разбирает дату, введённую пользователем: «ДД.ММ.ГГГГ» (допускается «Д.М.ГГГГ»). null — если даты нет в календаре. */
export function parseUserDate(input: string): IsoDate | null {
  const match = USER_DATE.exec(input.trim());
  if (!match) return null;
  const value = DateTime.fromObject(
    { year: Number(match[3]), month: Number(match[2]), day: Number(match[1]) },
    { zone: 'utc' },
  );
  return value.isValid ? toIso(value) : null;
}

/** «ДД.ММ.ГГГГ» — как дата показывается пользователю. */
export function formatUserDate(date: IsoDate): string {
  return toDateTime(date).toFormat('dd.MM.yyyy');
}

/** ISO-дата ↔ Date для полей Prisma `@db.Date` (полночь UTC). */
export function isoToDbDate(date: IsoDate): Date {
  return toDateTime(date).toJSDate();
}

export function dbDateToIso(date: Date): IsoDate {
  return toIso(DateTime.fromJSDate(date, { zone: 'utc' }));
}
