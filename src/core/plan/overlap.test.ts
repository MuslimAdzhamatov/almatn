import { describe, expect, it } from 'vitest';
import { addMonths } from './dates.js';
import { reviewEvents } from './load.js';
import { forecastOverlap, remainingPlanEvents } from './overlap.js';

const WED = '2026-09-16';

describe('оставшиеся порции другого плана', () => {
  it('начинаются с завтрашнего дня и с nextLine', () => {
    const events = remainingPlanEvents(
      { nextLine: 6, lineTo: 10, unitsPerDay: 5, startDate: '2026-09-01', restDays: [] },
      WED,
    );
    expect(events.map((e) => e.date)).toEqual([
      '2026-09-17',
      '2026-09-18',
      '2026-09-20',
      '2026-10-01',
      '2026-10-17',
    ]);
    expect(events.every((e) => e.units === 5)).toBe(true);
  });

  it('план, который начнётся позже, — с даты начала', () => {
    const events = remainingPlanEvents(
      { nextLine: 1, lineTo: 2, unitsPerDay: 2, startDate: '2026-10-01', restDays: [] },
      WED,
    );
    expect(events[0]?.date).toBe('2026-10-01');
  });

  it('всё выдано — повторов от новых порций нет', () => {
    expect(
      remainingPlanEvents(
        { nextLine: 11, lineTo: 10, unitsPerDay: 5, startDate: WED, restDays: [] },
        WED,
      ),
    ).toEqual([]);
  });
});

describe('наложение планов', () => {
  it('считает ближайшие повторы и общий пик', () => {
    const existing = [
      { date: WED, units: 5 },
      { date: '2026-09-20', units: 10 },
      { date: '2026-10-30', units: 7 },
    ];
    const added = reviewEvents([{ seq: 1, date: '2026-09-20', from: 1, to: 3 }]);
    expect(forecastOverlap(existing, added, WED, { from: '2026-09-20', to: '2026-09-20' })).toEqual(
      { upcomingTotal: 15, upcomingPeak: 10, combinedPeak: 13 },
    );
  });

  it('других планов нет', () => {
    expect(forecastOverlap([], [], WED, { from: WED, to: WED })).toEqual({
      upcomingTotal: 0,
      upcomingPeak: 0,
      combinedPeak: 0,
    });
  });

  it('календарные месяцы для подсказок срока', () => {
    expect(addMonths(WED, 6)).toBe('2027-03-16');
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
  });
});
