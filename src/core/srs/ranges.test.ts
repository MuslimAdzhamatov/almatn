import { describe, expect, it } from 'vitest';
import { mergeRanges, rangesSpan, type RangeUnit } from './ranges.js';

const units = (to: number, skipped: number[] = []): RangeUnit[] =>
  Array.from({ length: to }, (_, i) => ({
    lineNumber: i + 1,
    skipped: skipped.includes(i + 1),
  }));
const r = (lineStart: number, lineEnd: number) => ({ lineStart, lineEnd });

describe('слияние диапазонов', () => {
  it('соседние сливаются', () => {
    expect(mergeRanges(units(20), [r(6, 10), r(1, 5)])).toEqual([
      { lineStart: 1, lineEnd: 10, count: 10 },
    ]);
  });

  it('пересекающиеся и вложенные сливаются', () => {
    expect(mergeRanges(units(20), [r(1, 6), r(4, 9), r(5, 5)])).toEqual([
      { lineStart: 1, lineEnd: 9, count: 9 },
    ]);
  });

  it('несмежные остаются отдельно', () => {
    expect(mergeRanges(units(20), [r(16, 20), r(1, 5)])).toEqual([
      { lineStart: 1, lineEnd: 5, count: 5 },
      { lineStart: 16, lineEnd: 20, count: 5 },
    ]);
  });

  it('пропущенная единица между диапазонами не разрывает их', () => {
    expect(mergeRanges(units(20, [6]), [r(1, 5), r(7, 10)])).toEqual([
      { lineStart: 1, lineEnd: 10, count: 9 },
    ]);
  });

  it('непропущенная единица между диапазонами разрывает их', () => {
    expect(mergeRanges(units(20, [6]), [r(1, 5), r(8, 10)])).toEqual([
      { lineStart: 1, lineEnd: 5, count: 5 },
      { lineStart: 8, lineEnd: 10, count: 3 },
    ]);
  });

  it('края подрезаются до непропущенных, диапазон из одних пропущенных выпадает', () => {
    expect(mergeRanges(units(20, [1, 2, 5, 12, 13]), [r(1, 5), r(12, 13)])).toEqual([
      { lineStart: 3, lineEnd: 4, count: 2 },
    ]);
  });

  it('пусто', () => {
    expect(mergeRanges(units(5), [])).toEqual([]);
    expect(rangesSpan([])).toBeNull();
  });

  it('границы для запроса единиц', () => {
    expect(rangesSpan([r(16, 20), r(1, 5)])).toEqual(r(1, 20));
  });
});
