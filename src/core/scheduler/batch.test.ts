import { describe, expect, it } from 'vitest';
import {
  batchContent,
  batchDedupeKey,
  debtDays,
  debtSince,
  eventsOfDay,
  immediateEvent,
  isQuietDebt,
  latestEvent,
  shouldAutoPause,
  type BatchReview,
  type BatchRules,
  type SlotEvent,
} from './batch.js';

const at = (s: string) => new Date(s);
const rules = (dailySendTime: string, extra: Partial<BatchRules> = {}): BatchRules => ({
  timezone: 'Europe/Moscow',
  dailySendTime,
  eveningReminderTime: '21:00',
  nightStart: '23:00',
  nightEnd: '07:00',
  nightPolicy: 'keep',
  ...extra,
});
const show = (events: SlotEvent[]) =>
  events.map((e) => `${e.kind} ${e.at.toISOString()} → ${e.sendAt.toISOString()}`);

describe('события плановых суток', () => {
  it('основной 06:00: основной, второй, вечер', () => {
    expect(show(eventsOfDay('2026-09-16', rules('06:00')))).toEqual([
      'main 2026-09-16T03:00:00.000Z → 2026-09-16T03:00:00.000Z',
      'second 2026-09-16T15:00:00.000Z → 2026-09-16T15:00:00.000Z',
      'evening 2026-09-16T18:00:00.000Z → 2026-09-16T18:00:00.000Z',
    ]);
  });

  it('основной 20:00 и 22:00: вечернего напоминания нет', () => {
    expect(show(eventsOfDay('2026-09-16', rules('20:00')))).toEqual([
      'main 2026-09-16T17:00:00.000Z → 2026-09-16T17:00:00.000Z',
      'second 2026-09-17T05:00:00.000Z → 2026-09-17T05:00:00.000Z',
    ]);
    expect(eventsOfDay('2026-09-16', rules('22:00')).map((e) => e.kind)).toEqual([
      'main',
      'second',
    ]);
  });

  it('тихие часы: keep — по часам, move — на утро', () => {
    const keep = eventsOfDay('2026-09-16', rules('14:00'));
    expect(keep[2]).toMatchObject({ kind: 'second', sendAt: at('2026-09-16T23:00:00Z') });
    const move = eventsOfDay('2026-09-16', rules('14:00', { nightPolicy: 'move' }));
    expect(move.map((e) => e.kind)).toEqual(['main', 'evening', 'second']);
    expect(move[2]).toMatchObject({
      at: at('2026-09-16T23:00:00Z'),
      sendAt: at('2026-09-17T04:00:00Z'),
    });
  });

  it('основной слот в тихие часы не переносится', () => {
    const events = eventsOfDay('2026-09-16', rules('02:00', { nightPolicy: 'move' }));
    expect(events[0]).toMatchObject({ kind: 'main', sendAt: at('2026-09-15T23:00:00Z') });
  });

  it('перенос за следующий основной слот — событие выпадает', () => {
    const s = rules('06:00', { eveningReminderTime: '23:30', nightPolicy: 'move' });
    expect(eventsOfDay('2026-09-16', s).map((e) => e.kind)).toEqual(['main', 'second']);
    const kept = rules('06:00', { eveningReminderTime: '23:30' });
    expect(eventsOfDay('2026-09-16', kept).map((e) => e.kind)).toEqual([
      'main',
      'second',
      'evening',
    ]);
  });
});

describe('последнее наступившее событие', () => {
  const s = rules('06:00');
  it.each([
    ['2026-09-16T03:00:00Z', 'main', '2026-09-16'],
    ['2026-09-16T14:59:00Z', 'main', '2026-09-16'],
    ['2026-09-16T15:00:00Z', 'second', '2026-09-16'],
    ['2026-09-16T19:00:00Z', 'evening', '2026-09-16'],
    ['2026-09-17T02:59:00Z', 'evening', '2026-09-16'],
    ['2026-09-17T03:00:00Z', 'main', '2026-09-17'],
  ])('%s → %s', (now, kind, day) => {
    expect(latestEvent(at(now), s)).toMatchObject({ kind, day });
  });

  it('внеочередная сводка — как основной слот в момент now', () => {
    expect(immediateEvent(at('2026-09-16T02:00:00Z'), s)).toEqual({
      kind: 'main',
      day: '2026-09-15',
      at: at('2026-09-16T02:00:00Z'),
      sendAt: at('2026-09-16T02:00:00Z'),
    });
  });

  it('догон после простоя — одно событие с одним ключом', () => {
    const a = latestEvent(at('2026-09-16T16:00:00Z'), s);
    const b = latestEvent(at('2026-09-16T17:59:00Z'), s);
    expect(batchDedupeKey(7, a)).toBe(batchDedupeKey(7, b));
    expect(batchDedupeKey(7, a)).toBe('batch:7:second:2026-09-16T15:00:00.000Z');
  });
});

describe('состав сообщения', () => {
  const now = at('2026-09-16T15:00:00Z');
  const s = rules('06:00');
  const main = eventsOfDay('2026-09-16', s)[0]!;
  const second = eventsOfDay('2026-09-16', s)[1]!;
  const evening = eventsOfDay('2026-09-16', s)[2]!;
  const reviews: BatchReview[] = [
    { id: 1, dueAt: at('2026-09-16T15:00:00Z'), status: 'pending' },
    { id: 2, dueAt: at('2026-09-16T03:00:00Z'), status: 'sent' },
    { id: 3, dueAt: at('2026-09-15T15:00:00Z'), status: 'missed' },
    { id: 4, dueAt: at('2026-09-15T03:00:00Z'), status: 'confirmed' },
    { id: 5, dueAt: at('2026-09-15T03:00:00Z'), status: 'cancelled' },
    { id: 6, dueAt: at('2026-09-17T03:00:00Z'), status: 'pending' },
  ];

  it('второй слот — только новые наступившие', () => {
    expect(
      batchContent({ now, event: second, reviews, unlearned: { id: 9, sentAt: main.at } }),
    ).toEqual({ reviewIds: [1], portionId: null });
    expect(
      batchContent({ now, event: second, reviews: reviews.slice(1), unlearned: null }),
    ).toBeNull();
  });

  it('основной слот и вечер — весь долг и невыученная порция', () => {
    const old = { id: 9, sentAt: at('2026-09-15T03:00:00Z') };
    expect(batchContent({ now, event: main, reviews, unlearned: old })).toEqual({
      reviewIds: [1, 2, 3],
      portionId: 9,
    });
    expect(batchContent({ now, event: evening, reviews: [], unlearned: old })).toEqual({
      reviewIds: [],
      portionId: 9,
    });
  });

  it('порция, выданная в этот слот, в сообщение слота не входит, а вечером входит', () => {
    const today = { id: 9, sentAt: main.at };
    expect(batchContent({ now, event: main, reviews: [], unlearned: today })).toBeNull();
    expect(batchContent({ now, event: evening, reviews: [], unlearned: today })).toEqual({
      reviewIds: [],
      portionId: 9,
    });
  });

  it('долга нет — вечером ничего', () => {
    expect(batchContent({ now, event: evening, reviews: reviews.slice(3), unlearned: null })).toBe(
      null,
    );
  });
});

describe('защита от спама', () => {
  const s = rules('06:00');
  const reviews: BatchReview[] = [
    { id: 1, dueAt: at('2026-09-13T03:00:00Z'), status: 'confirmed' },
    { id: 2, dueAt: at('2026-09-13T15:00:00Z'), status: 'missed' },
    { id: 3, dueAt: at('2026-09-14T03:00:00Z'), status: 'sent' },
  ];

  it('начало долга — самый ранний неподтверждённый повтор или порция', () => {
    const now = at('2026-09-16T10:00:00Z');
    expect(debtSince(now, reviews, null)).toEqual(at('2026-09-13T15:00:00Z'));
    expect(debtSince(now, [], { id: 1, sentAt: at('2026-09-12T03:00:00Z') })).toEqual(
      at('2026-09-12T03:00:00Z'),
    );
    expect(debtSince(now, reviews.slice(0, 1), null)).toBeNull();
  });

  it('3 плановых суток долга — одно сообщение в сутки', () => {
    const since = at('2026-09-13T15:00:00Z');
    expect(debtDays(since, at('2026-09-16T02:59:00Z'), s)).toBe(2);
    expect(isQuietDebt(since, at('2026-09-16T02:59:00Z'), s)).toBe(false);
    expect(isQuietDebt(since, at('2026-09-16T03:00:00Z'), s)).toBe(true);
    expect(isQuietDebt(null, at('2026-09-16T03:00:00Z'), s)).toBe(false);
  });

  it('автопауза — 7 дней без активности и долг хотя бы сутки', () => {
    const last = at('2026-09-09T10:00:00Z');
    const oldDebt = at('2026-09-15T03:00:00Z');
    expect(shouldAutoPause(last, at('2026-09-16T10:00:00Z'), oldDebt, s)).toBe(true);
    expect(shouldAutoPause(last, at('2026-09-16T09:59:00Z'), oldDebt, s)).toBe(false);
    expect(shouldAutoPause(last, at('2026-09-20T10:00:00Z'), null, s)).toBe(false);
    // Повтор только что наступил — сначала он должен прийти.
    const fresh = at('2026-09-16T03:00:00Z');
    expect(shouldAutoPause(last, at('2026-09-16T03:00:00Z'), fresh, s)).toBe(false);
    expect(shouldAutoPause(last, at('2026-09-17T03:00:00Z'), fresh, s)).toBe(true);
  });
});
