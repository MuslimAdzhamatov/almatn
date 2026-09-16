import { addDays, diffDays, type IsoDate } from '../plan/dates.js';
import {
  applyQuietHours,
  mainSlotOn,
  planningDayOf,
  secondSlotOn,
  type QuietSettings,
} from '../srs/slots.js';
import { eveningReminderAt, type ReviewState, type ScheduleRules } from './rules.js';

// Сводные повторы и напоминания о долге (CLAUDE.md, разделы 5.1 и 5.2):
// какое событие плановых суток наступило, что входит в сообщение, защита от спама.

const DAY = 24 * 60 * 60 * 1000;
/** Столько плановых суток долга — и по тексту остаётся одно сообщение в сутки. */
export const QUIET_DEBT_DAYS = 3;
/** Столько дней без нажатий и команд при долге — автопауза. */
export const AUTO_PAUSE_DAYS = 7;

export type SlotEventKind = 'main' | 'second' | 'evening';

export interface SlotEvent {
  kind: SlotEventKind;
  /** Плановые сутки события. */
  day: IsoDate;
  /** Момент по расписанию (для ключа отправки). */
  at: Date;
  /** Когда отправлять с учётом тихих часов (основной слот ночным не считается). */
  sendAt: Date;
}

export interface BatchRules extends ScheduleRules, QuietSettings {}

/**
 * События плановых суток по порядку. Второй слот и вечер, которые тихие часы перенесли
 * на следующий основной слот или позже, выпадают — всё войдёт в сообщение основного слота.
 */
export function eventsOfDay(day: IsoDate, s: BatchRules): SlotEvent[] {
  const main = mainSlotOn(day, s);
  const nextMain = mainSlotOn(addDays(day, 1), s);
  const events: SlotEvent[] = [{ kind: 'main', day, at: main, sendAt: main }];
  const second = secondSlotOn(day, s);
  events.push({ kind: 'second', day, at: second, sendAt: applyQuietHours(second, s) });
  const evening = eveningReminderAt(day, s);
  if (evening) {
    events.push({ kind: 'evening', day, at: evening, sendAt: applyQuietHours(evening, s) });
  }
  return events
    .filter((e) => e.kind === 'main' || e.sendAt < nextMain)
    .sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
}

/**
 * Последнее наступившее событие: после простоя отправляется только оно, один раз.
 * Основной слот текущих плановых суток всегда уже наступил, поэтому результат есть всегда.
 */
export function latestEvent(now: Date, s: BatchRules): SlotEvent {
  return eventsOfDay(planningDayOf(now, s), s)
    .filter((e) => e.sendAt <= now)
    .at(-1)!;
}

/** Внеочередная сводка всего долга (после паузы): как в основной слот, но в момент now. */
export function immediateEvent(now: Date, s: BatchRules): SlotEvent {
  return { kind: 'main', day: planningDayOf(now, s), at: now, sendAt: now };
}

/** Ключ отправки: одно сообщение на текст за событие. */
export function batchDedupeKey(textId: number, event: SlotEvent): string {
  return `batch:${textId}:${event.kind}:${event.at.toISOString()}`;
}

export interface BatchReview extends ReviewState {
  id: number;
}

export interface BatchPortion {
  id: number;
  sentAt: Date;
}

export interface BatchInput {
  now: Date;
  event: SlotEvent;
  reviews: readonly BatchReview[];
  /** Последняя порция без «Выучил». */
  unlearned: BatchPortion | null;
}

export interface BatchContent {
  reviewIds: number[];
  /** Порция, которую нужно выучить (кнопка «Выучил …»). */
  portionId: number | null;
}

/** Наступивший и не подтверждённый повтор — долг. */
const isOwed = (r: ReviewState, now: Date) =>
  r.dueAt <= now && (r.status === 'pending' || r.status === 'sent' || r.status === 'missed');

/**
 * Что входит в сообщение события:
 * - второй слот — только новые наступившие повторы (ещё не отправлявшиеся);
 * - основной слот и вечер — весь долг: наступившие неподтверждённые повторы и невыученная
 *   порция, выданная раньше события (порция, выданная в этот же слот, долгом ещё не считается);
 * - вечером сообщение приходит, только если долг есть.
 * null — отправлять нечего.
 */
export function batchContent(input: BatchInput): BatchContent | null {
  const { now, event, unlearned } = input;
  if (event.kind === 'second') {
    const reviewIds = input.reviews
      .filter((r) => r.status === 'pending' && r.dueAt <= now)
      .map((r) => r.id);
    return reviewIds.length > 0 ? { reviewIds, portionId: null } : null;
  }
  const reviewIds = input.reviews.filter((r) => isOwed(r, now)).map((r) => r.id);
  const portionId = unlearned && unlearned.sentAt < event.at ? unlearned.id : null;
  if (reviewIds.length === 0 && portionId === null) return null;
  return { reviewIds, portionId };
}

/** С какого момента тянется долг по тексту (null — долга нет). */
export function debtSince(
  now: Date,
  reviews: readonly ReviewState[],
  unlearned: BatchPortion | null,
): Date | null {
  const moments = reviews.filter((r) => isOwed(r, now)).map((r) => r.dueAt.getTime());
  if (unlearned) moments.push(unlearned.sentAt.getTime());
  return moments.length > 0 ? new Date(Math.min(...moments)) : null;
}

/** Сколько плановых суток прошло с начала долга (0 — долг появился в эти сутки). */
export function debtDays(since: Date, now: Date, s: ScheduleRules): number {
  return diffDays(planningDayOf(since, s), planningDayOf(now, s));
}

/**
 * Долг тянется 3 плановых суток и дольше — по тексту приходит только сообщение основного слота,
 * без второго слота, вечера и напоминания про порцию.
 */
export function isQuietDebt(since: Date | null, now: Date, s: ScheduleRules): boolean {
  return since !== null && debtDays(since, now, s) >= QUIET_DEBT_DAYS;
}

/**
 * Автопауза: 7 дней без нажатий и команд, и при этом есть долг хотя бы по одному тексту.
 * Без долга пользователю может быть просто нечего нажимать (между повторами +2 нед и +1 мес).
 */
export function shouldAutoPause(lastActivityAt: Date, now: Date, hasAnyDebt: boolean): boolean {
  return hasAnyDebt && now.getTime() - lastActivityAt.getTime() >= AUTO_PAUSE_DAYS * DAY;
}
