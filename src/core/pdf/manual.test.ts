import { describe, expect, it } from 'vitest';
import { pagesAsSlices, pagesAsUnits } from './manual.js';

const pages = [
  { page: 3, widthPt: 595, heightPt: 840 },
  { page: 4, widthPt: 595, heightPt: 840 },
];

describe('pagesAsUnits', () => {
  it('единица — страница целиком, нумерация подряд', () => {
    const boxes = pagesAsUnits(pages);
    expect(boxes.map((box) => [box.lineNumber, box.page])).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(boxes[0]?.fragments).toEqual([
      { kind: 'text', page: 3, yTop: 0, yBottom: 840, xLeft: null, xRight: null },
    ]);
  });
});

describe('pagesAsSlices', () => {
  it('делит страницу на равные полосы без зазоров', () => {
    const boxes = pagesAsSlices(pages, 4);
    expect(boxes).toHaveLength(8);
    expect(boxes.map((box) => box.lineNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const first = boxes.slice(0, 4).map((box) => box.fragments[0]!);
    expect(first.map((fragment) => [fragment.yTop, fragment.yBottom])).toEqual([
      [0, 210],
      [210, 420],
      [420, 630],
      [630, 840],
    ]);
    expect(boxes[4]).toMatchObject({ lineNumber: 5, page: 4 });
  });

  it('одна полоса на страницу — то же, что страница целиком', () => {
    expect(pagesAsSlices(pages, 1)).toEqual(pagesAsUnits(pages));
  });

  it('меньше одной полосы не бывает', () => {
    expect(() => pagesAsSlices(pages, 0)).toThrow();
  });
});
