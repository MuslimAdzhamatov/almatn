import { DateTime } from 'luxon';
import { addDays, type IsoDate } from '../plan/dates.js';
import { requireHHmm, shiftHHmm, toMinutes } from '../time/hhmm.js';
import { isQuietTime, type NightPolicy } from '../time/schedule.js';

// Слоты отправки (CLAUDE.md, разделы 5 и 5.1): основной — время, выбранное пользователем,
// второй — на 12 часов позже по местным часам. «+N суток» — тот же местный час N дней спустя.

export interface SlotSettings {
  timezone: string;
  dailySendTime: string;
}

export type SlotKind = 'main' | 'second';

export interface Slot {
  at: Date;
  kind: SlotKind;
  /** Плановые сутки, к которым относится слот (дата основного слота). */
  day: IsoDate;
}

/** Момент местного времени «date HH:mm»; несуществующее время (переход на летнее) luxon сдвигает вперёд. */
export function localMoment(date: IsoDate, time: string, timezone: string): Date {
  const { hour, minute } = requireHHmm(time);
  const [year, month, day] = date.split('-').map(Number);
  return DateTime.fromObject({ year, month, day, hour, minute }, { zone: timezone }).toJSDate();
}

export function localDateOf(at: Date, timezone: string): IsoDate {
  return DateTime.fromJSDate(at, { zone: timezone }).toISODate() as IsoDate;
}

export function mainSlotOn(day: IsoDate, s: SlotSettings): Date {
  return localMoment(day, s.dailySendTime, s.timezone);
}

/** Второй слот плановых суток day: 06:00 → 18:00 того же дня, 20:00 → 08:00 следующего. */
export function secondSlotOn(day: IsoDate, s: SlotSettings): Date {
  const second = shiftHHmm(s.dailySendTime, 12 * 60);
  const wraps = toMinutes(requireHHmm(second)) < toMinutes(requireHHmm(s.dailySendTime));
  return localMoment(wraps ? addDays(day, 1) : day, second, s.timezone);
}

export function slotOn(day: IsoDate, kind: SlotKind, s: SlotSettings): Slot {
  return { at: kind === 'main' ? mainSlotOn(day, s) : secondSlotOn(day, s), kind, day };
}

/** Плановые сутки — от основного слота одного дня до основного слота следующего. */
export function planningDayOf(at: Date, s: SlotSettings): IsoDate {
  const date = localDateOf(at, s.timezone);
  return at < mainSlotOn(date, s) ? addDays(date, -1) : date;
}

function slotsAround(at: Date, s: SlotSettings): Slot[] {
  const day = planningDayOf(at, s);
  return [-1, 0, 1].flatMap((offset) => {
    const d = addDays(day, offset);
    return [slotOn(d, 'main', s), slotOn(d, 'second', s)];
  });
}

/** Последний слот не позже at. */
export function previousSlot(at: Date, s: SlotSettings): Slot {
  return slotsAround(at, s)
    .filter((slot) => slot.at <= at)
    .at(-1)!;
}

/** Первый слот строго после at. */
export function nextSlot(at: Date, s: SlotSettings): Slot {
  return slotsAround(at, s).find((slot) => slot.at > at)!;
}

/** Ближайший к at слот в любую сторону; при равенстве — следующий. */
export function nearestSlot(at: Date, s: SlotSettings): Slot {
  const before = previousSlot(at, s);
  const after = nextSlot(at, s);
  return at.getTime() - before.at.getTime() < after.at.getTime() - at.getTime() ? before : after;
}

export const REVIEW_STAGES = ['rep_12h', 'rep_1d', 'rep_3d', 'rep_2w', 'rep_1m'] as const;
export type RepStage = (typeof REVIEW_STAGES)[number];

/**
 * Цепочка для единиц, которые пользователь уже знал до плана (CLAUDE.md, раздел 5.3):
 * без +12 ч — он нужен свежевыученному, а известное повторяется начиная со следующих суток.
 */
export const KNOWN_REVIEW_STAGES: readonly RepStage[] = ['rep_1d', 'rep_3d', 'rep_2w', 'rep_1m'];

const STAGE_DAYS: Record<Exclude<RepStage, 'rep_12h'>, number> = {
  rep_1d: 1,
  rep_3d: 3,
  rep_2w: 14,
  rep_1m: 30,
};

export interface ScheduledStage {
  stage: RepStage;
  dueAt: Date;
}

/**
 * Цепочка повторов от anchorAt: +12 ч — противоположный слот, остальные — тот же слот через N суток.
 * Если слот +12 ч уже прошёл к моменту now, повтор получает ближайший будущий слот.
 * `stages` сужает набор этапов (известные единицы идут без +12 ч).
 */
export function reviewChain(
  anchor: Slot,
  now: Date,
  s: SlotSettings,
  stages: readonly RepStage[] = REVIEW_STAGES,
): ScheduledStage[] {
  const chain: ScheduledStage[] = [];
  if (stages.includes('rep_12h')) {
    const half =
      anchor.kind === 'main'
        ? slotOn(anchor.day, 'second', s)
        : slotOn(addDays(anchor.day, 1), 'main', s);
    chain.push({ stage: 'rep_12h', dueAt: half.at > now ? half.at : nextSlot(now, s).at });
  }
  for (const [stage, days] of Object.entries(STAGE_DAYS) as [RepStage, number][]) {
    if (!stages.includes(stage)) continue;
    chain.push({ stage, dueAt: slotOn(addDays(anchor.day, days), anchor.kind, s).at });
  }
  return chain;
}

export interface QuietSettings {
  timezone: string;
  nightStart: string;
  nightEnd: string;
  nightPolicy: NightPolicy;
}

/**
 * Когда отправить сообщение, запланированное на at (кроме основного слота — он ночным не считается):
 * при политике move сообщение из тихих часов уходит в ближайшее nightEnd.
 */
export function applyQuietHours(at: Date, q: QuietSettings): Date {
  if (q.nightPolicy !== 'move') return at;
  const local = DateTime.fromJSDate(at, { zone: q.timezone });
  if (!isQuietTime(local.toFormat('HH:mm'), { start: q.nightStart, end: q.nightEnd })) return at;
  const date = local.toISODate() as IsoDate;
  const sameDay = localMoment(date, q.nightEnd, q.timezone);
  return sameDay > at ? sameDay : localMoment(addDays(date, 1), q.nightEnd, q.timezone);
}
