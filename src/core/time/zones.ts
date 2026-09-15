import { DateTime } from 'luxon';

// Каталог часовых поясов для выбора кнопками «город + смещение» (CLAUDE.md, раздел 5.4).
// За кнопкой — IANA-пояс города, поэтому смещение считается на текущую дату
// и переход на летнее время учитывается автоматически.

export type ZoneGroup = 'russia' | 'world' | 'utc';

export const ZONE_GROUPS: readonly ZoneGroup[] = ['russia', 'world', 'utc'];

export interface ZoneOption {
  iana: string;
  city: string | null;
  group: ZoneGroup;
}

export interface ZoneNow {
  iana: string;
  city: string | null;
  offsetMinutes: number;
  local: DateTime;
}

const cities = (group: ZoneGroup, list: [city: string, iana: string][]): ZoneOption[] =>
  list.map(([city, iana]) => ({ city, iana, group }));

const utcOffsets: ZoneOption[] = Array.from({ length: 27 }, (_, index) => {
  const offset = index - 12;
  // В IANA знак у Etc/GMT инвертирован: Etc/GMT-3 — это UTC+3.
  const iana = offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
  return { city: null, iana, group: 'utc' };
});

export const ZONE_OPTIONS: readonly ZoneOption[] = [
  ...cities('russia', [
    ['Калининград', 'Europe/Kaliningrad'],
    ['Москва', 'Europe/Moscow'],
    ['Самара', 'Europe/Samara'],
    ['Екатеринбург', 'Asia/Yekaterinburg'],
    ['Омск', 'Asia/Omsk'],
    ['Новосибирск', 'Asia/Novosibirsk'],
    ['Красноярск', 'Asia/Krasnoyarsk'],
    ['Иркутск', 'Asia/Irkutsk'],
    ['Якутск', 'Asia/Yakutsk'],
    ['Владивосток', 'Asia/Vladivostok'],
    ['Магадан', 'Asia/Magadan'],
    ['Камчатка', 'Asia/Kamchatka'],
  ]),
  ...cities('world', [
    ['Нью-Йорк', 'America/New_York'],
    ['Лондон', 'Europe/London'],
    ['Берлин', 'Europe/Berlin'],
    ['Каир', 'Africa/Cairo'],
    ['Киев', 'Europe/Kyiv'],
    ['Минск', 'Europe/Minsk'],
    ['Стамбул', 'Europe/Istanbul'],
    ['Эр-Рияд', 'Asia/Riyadh'],
    ['Тегеран', 'Asia/Tehran'],
    ['Баку', 'Asia/Baku'],
    ['Дубай', 'Asia/Dubai'],
    ['Ташкент', 'Asia/Tashkent'],
    ['Алматы', 'Asia/Almaty'],
    ['Бишкек', 'Asia/Bishkek'],
  ]),
  ...utcOffsets,
];

export function isZoneGroup(value: string): value is ZoneGroup {
  return (ZONE_GROUPS as readonly string[]).includes(value);
}

export function findZoneOption(iana: string): ZoneOption | undefined {
  return ZONE_OPTIONS.find((option) => option.iana === iana);
}

/** Текущее местное время и смещение пояса в момент now. */
export function describeZone(iana: string, now: Date): ZoneNow {
  const local = DateTime.fromJSDate(now).setZone(iana);
  if (!local.isValid) throw new Error(`Неизвестный часовой пояс: ${iana}`);
  return { iana, city: findZoneOption(iana)?.city ?? null, offsetMinutes: local.offset, local };
}

/** Пояса группы, отсортированные по смещению в момент now (при равенстве — в порядке каталога). */
export function listZones(group: ZoneGroup, now: Date): ZoneNow[] {
  return ZONE_OPTIONS.filter((option) => option.group === group)
    .map((option) => describeZone(option.iana, now))
    .sort((a, b) => a.offsetMinutes - b.offsetMinutes);
}

/** Смещение для подписи: +3, +5:30, −5, +0. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '−' : '+';
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}
