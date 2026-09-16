import { describe, expect, it } from 'vitest';
import {
  applyQuietHours,
  mainSlotOn,
  nearestSlot,
  nextSlot,
  planningDayOf,
  previousSlot,
  reviewChain,
  secondSlotOn,
} from './slots.js';

const MSK = { timezone: 'Europe/Moscow', dailySendTime: '06:00' };
const iso = (d: Date) => d.toISOString();
const at = (s: string) => new Date(s);

describe('слоты', () => {
  it('основной и второй слот по местному времени', () => {
    expect(iso(mainSlotOn('2026-09-16', MSK))).toBe('2026-09-16T03:00:00.000Z');
    expect(iso(secondSlotOn('2026-09-16', MSK))).toBe('2026-09-16T15:00:00.000Z');
    // 20:00 → второй слот в 08:00 следующего дня.
    const evening = { ...MSK, dailySendTime: '20:00' };
    expect(iso(secondSlotOn('2026-09-16', evening))).toBe('2026-09-17T05:00:00.000Z');
  });

  it('плановые сутки начинаются с основного слота', () => {
    expect(planningDayOf(at('2026-09-16T02:59:00Z'), MSK)).toBe('2026-09-15');
    expect(planningDayOf(at('2026-09-16T03:00:00Z'), MSK)).toBe('2026-09-16');
    expect(planningDayOf(at('2026-09-16T20:59:00Z'), MSK)).toBe('2026-09-16');
    const evening = { ...MSK, dailySendTime: '20:00' };
    // 17.09 07:00 по Москве — ещё сутки 16.09 (основной слот 16.09 в 20:00).
    expect(planningDayOf(at('2026-09-17T04:00:00Z'), evening)).toBe('2026-09-16');
  });

  it('предыдущий, следующий и ближайший слот', () => {
    const t = at('2026-09-16T08:00:00Z'); // 11:00 МСК
    expect(previousSlot(t, MSK)).toMatchObject({ kind: 'main', day: '2026-09-16' });
    expect(nextSlot(t, MSK)).toMatchObject({ kind: 'second', day: '2026-09-16' });
    expect(nearestSlot(t, MSK).kind).toBe('main'); // 5 ч назад против 7 ч вперёд
    expect(nearestSlot(at('2026-09-16T10:00:00Z'), MSK).kind).toBe('second'); // 13:00
    // Ровно посередине — следующий.
    expect(nearestSlot(at('2026-09-16T09:00:00Z'), MSK).kind).toBe('second');
    // 02:00 МСК — ближайший основной 06:00 того же дня.
    expect(nearestSlot(at('2026-09-15T23:00:00Z'), MSK)).toMatchObject({
      kind: 'main',
      day: '2026-09-16',
    });
    // Сам слот — не «следующий».
    expect(iso(nextSlot(at('2026-09-16T03:00:00Z'), MSK).at)).toBe('2026-09-16T15:00:00.000Z');
    expect(iso(previousSlot(at('2026-09-16T03:00:00Z'), MSK).at)).toBe('2026-09-16T03:00:00.000Z');
  });
});

describe('цепочка повторов', () => {
  it('от основного слота: +12 ч — второй слот, остальные — основной через N суток', () => {
    const anchor = nearestSlot(at('2026-09-16T05:00:00Z'), MSK);
    const chain = reviewChain(anchor, at('2026-09-16T05:00:00Z'), MSK);
    expect(chain.map((c) => [c.stage, iso(c.dueAt)])).toEqual([
      ['rep_12h', '2026-09-16T15:00:00.000Z'],
      ['rep_1d', '2026-09-17T03:00:00.000Z'],
      ['rep_3d', '2026-09-19T03:00:00.000Z'],
      ['rep_2w', '2026-09-30T03:00:00.000Z'],
      ['rep_1m', '2026-10-16T03:00:00.000Z'],
    ]);
  });

  it('от второго слота: +12 ч — основной слот следующих суток', () => {
    const now = at('2026-09-16T14:00:00Z');
    const chain = reviewChain(nearestSlot(now, MSK), now, MSK);
    expect(iso(chain[0]!.dueAt)).toBe('2026-09-17T03:00:00.000Z');
    expect(iso(chain[1]!.dueAt)).toBe('2026-09-17T15:00:00.000Z');
  });

  it('+1 сутки — тот же местный час через переход на зимнее время', () => {
    const berlin = { timezone: 'Europe/Berlin', dailySendTime: '06:00' };
    const now = at('2026-10-24T04:00:00Z'); // 06:00 CEST
    const chain = reviewChain(nearestSlot(now, berlin), now, berlin);
    // 25.10 переход на CET: 06:00 местного — уже 05:00 UTC.
    expect(iso(chain[1]!.dueAt)).toBe('2026-10-25T05:00:00.000Z');
    expect(iso(chain[2]!.dueAt)).toBe('2026-10-27T05:00:00.000Z');
  });

  it('прошедший слот +12 ч заменяется ближайшим будущим', () => {
    const anchor = { at: at('2026-09-16T03:00:00Z'), kind: 'main' as const, day: '2026-09-16' };
    const chain = reviewChain(anchor, at('2026-09-16T16:00:00Z'), MSK);
    expect(iso(chain[0]!.dueAt)).toBe('2026-09-17T03:00:00.000Z');
  });
});

describe('тихие часы', () => {
  const quiet = {
    timezone: 'Europe/Moscow',
    nightStart: '23:00',
    nightEnd: '07:00',
    nightPolicy: 'move' as const,
  };

  it('move переносит ночное сообщение на утро', () => {
    // 02:00 МСК → 07:00 того же дня.
    expect(iso(applyQuietHours(at('2026-09-15T23:00:00Z'), quiet))).toBe(
      '2026-09-16T04:00:00.000Z',
    );
    // 23:30 МСК → 07:00 следующего дня.
    expect(iso(applyQuietHours(at('2026-09-16T20:30:00Z'), quiet))).toBe(
      '2026-09-17T04:00:00.000Z',
    );
  });

  it('дневное время и keep не меняются', () => {
    const day = at('2026-09-16T10:00:00Z');
    expect(applyQuietHours(day, quiet)).toBe(day);
    const night = at('2026-09-15T23:00:00Z');
    expect(applyQuietHours(night, { ...quiet, nightPolicy: 'keep' })).toBe(night);
  });
});
