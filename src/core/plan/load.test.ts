import { describe, expect, it } from 'vitest';
import { buildPortionCalendar } from './calendar.js';
import { dailyLoad, forecastLoad, reviewEvents } from './load.js';
import { summarizePlan } from './summary.js';
import { addDays } from './dates.js';

const WED = '2026-09-16';
const thresholds = { maxUnitsPerDay: 10, maxPeakReview: 50 };

describe('прогноз нагрузки', () => {
  it('одна порция повторяется в день выдачи (+12 ч) и через 1, 3, 14, 30 дней', () => {
    const calendar = [{ seq: 1, date: WED, from: 1, to: 5 }];
    const load = dailyLoad(reviewEvents(calendar), WED, addDays(WED, 30));
    const days = load.flatMap((units, index) => (units ? [[index, units]] : []));
    expect(days).toEqual([
      [0, 5],
      [1, 5],
      [3, 5],
      [14, 5],
      [30, 5],
    ]);
  });

  it('повторы разных порций складываются', () => {
    const calendar = buildPortionCalendar({
      lineFrom: 1,
      lineTo: 6,
      unitsPerDay: 3,
      startDate: WED,
      restDays: [],
    });
    // Порции 16.09 и 17.09: 17.09 — +1д первой и +12ч второй.
    expect(dailyLoad(reviewEvents(calendar), WED, addDays(WED, 4))).toEqual([3, 6, 3, 3, 3]);
  });

  it('пик и «обычно» на установившемся плане', () => {
    const calendar = buildPortionCalendar({
      lineFrom: 1,
      lineTo: 500,
      unitsPerDay: 5,
      startDate: WED,
      restDays: [],
    });
    const forecast = forecastLoad(reviewEvents(calendar), WED, calendar.at(-1)!.date);
    // Когда работают все пять этапов: 5 × 5 = 25.
    expect(forecast.peak).toBe(25);
    expect(forecast.typicalHigh).toBe(25);
    expect(forecast.typicalLow).toBeGreaterThanOrEqual(15);
    expect(forecast.peakDate).toBe(addDays(WED, 30));
  });

  it('пустой период', () => {
    expect(forecastLoad([], WED, WED)).toEqual({
      typicalLow: 0,
      typicalHigh: 0,
      peak: 0,
      peakDate: null,
    });
  });
});

describe('сводка плана', () => {
  it('манзума: 5 бейтов в день, выходной — пятница', () => {
    const summary = summarizePlan(
      {
        lineFrom: 1,
        lineTo: 448,
        startDate: WED,
        restDays: [5],
        pace: { mode: 'per_day', unitsPerDay: 5 },
      },
      thresholds,
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary).toMatchObject({ totalUnits: 448, unitsPerDay: 5, portions: 90, restDays: [5] });
    expect(summary.lastReviewDate).toBe(addDays(summary.endDate, 30));
    expect(summary.load.peak).toBeLessThanOrEqual(25);
    expect(summary.load.typicalHigh).toBeGreaterThanOrEqual(15);
    expect(summary.overload).toEqual({ unitsPerDay: false, peak: false });
  });

  it('уже известные единицы добавляют повторов, но не считаются заучиванием', () => {
    const without = summarizePlan(
      {
        lineFrom: 101,
        lineTo: 200,
        startDate: WED,
        restDays: [],
        pace: { mode: 'per_day', unitsPerDay: 5 },
      },
      thresholds,
    );
    const withKnown = summarizePlan(
      {
        lineFrom: 101,
        lineTo: 200,
        startDate: WED,
        restDays: [],
        pace: { mode: 'per_day', unitsPerDay: 5 },
        known: { lineFrom: 1, lineTo: 100 },
      },
      thresholds,
    );
    expect(without.ok && withKnown.ok).toBe(true);
    if (!without.ok || !withKnown.ok) return;
    // Учить всё те же 100 единиц и столько же дней — известные идут только на повтор.
    expect(withKnown).toMatchObject({ totalUnits: 100, knownUnits: 100, portions: 20 });
    expect(withKnown.endDate).toBe(without.endDate);
    expect(without.knownUnits).toBe(0);
    // Известное повторяется рядом с новым: нагрузка примерно вдвое выше.
    expect(withKnown.load.peak).toBeGreaterThan(without.load.peak);
    expect(withKnown.load.typicalHigh).toBeGreaterThan(without.load.typicalHigh);
  });

  it('известного больше, чем нового: последние повторы считаются от него', () => {
    const summary = summarizePlan(
      {
        lineFrom: 41,
        lineTo: 50,
        startDate: WED,
        restDays: [],
        pace: { mode: 'per_day', unitsPerDay: 5 },
        known: { lineFrom: 1, lineTo: 40 },
      },
      thresholds,
    );
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    // Заучивание кончится за 2 дня, известное разложено на 8 — повторы тянутся от него.
    expect(summary.lastReviewDate).toBe(addDays(summary.endDate, 30 + 6));
  });

  it('перегрузка: много новых в день и большой пик', () => {
    const summary = summarizePlan(
      {
        lineFrom: 1,
        lineTo: 448,
        startDate: WED,
        restDays: [],
        pace: { mode: 'deadline', deadline: { kind: 'days', value: 30 } },
      },
      thresholds,
    );
    expect(summary).toMatchObject({ ok: true, unitsPerDay: 15, overload: { unitsPerDay: true } });
    if (summary.ok) expect(summary.load.peak).toBe(60);
    if (summary.ok) expect(summary.overload.peak).toBe(true);
  });

  it('пик учитывается только за период заучивания', () => {
    // 11 единиц по одной в день: пик 5 достигается только после +30 дней, но заучивание кончается раньше.
    const summary = summarizePlan(
      {
        lineFrom: 1,
        lineTo: 11,
        startDate: WED,
        restDays: [],
        pace: { mode: 'per_day', unitsPerDay: 1 },
      },
      thresholds,
    );
    expect(summary).toMatchObject({ ok: true, load: { peak: 3 } });
  });

  it('ошибка срока пробрасывается', () => {
    expect(
      summarizePlan(
        {
          lineFrom: 1,
          lineTo: 10,
          startDate: WED,
          restDays: [],
          pace: { mode: 'deadline', deadline: { kind: 'date', date: '2026-01-01' } },
        },
        thresholds,
      ),
    ).toEqual({ ok: false, reason: 'deadline_before_start' });
  });

  it('некорректный диапазон — ошибка программы', () => {
    expect(() =>
      summarizePlan(
        {
          lineFrom: 5,
          lineTo: 4,
          startDate: WED,
          restDays: [],
          pace: { mode: 'per_day', unitsPerDay: 1 },
        },
        thresholds,
      ),
    ).toThrow();
  });
});
