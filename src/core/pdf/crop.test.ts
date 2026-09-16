import { describe, expect, it } from 'vitest';
import { groupIntoSegments, segmentPixelRect } from './crop.js';
import type { LineBox } from './layout.js';
import { pagesAsUnits } from './manual.js';

const box = (lineNumber: number, page: number, yTop: number, yBottom: number): LineBox => ({
  lineNumber,
  printedNumber: lineNumber,
  page,
  sectionBreakBefore: false,
  fragments: [{ kind: 'text', page, yTop, yBottom, xLeft: 60, xRight: 560 }],
});

/** Единица из нескольких фрагментов: заголовок перед строкой, абзац на двух страницах. */
const multi = (lineNumber: number, fragments: LineBox['fragments']): LineBox => ({
  lineNumber,
  printedNumber: lineNumber,
  page: fragments[0]!.page,
  sectionBreakBefore: false,
  fragments,
});

describe('groupIntoSegments', () => {
  it('объединяет подряд идущие строки одной страницы', () => {
    const segments = groupIntoSegments([
      box(42, 3, 40, 70),
      box(41, 3, 10, 40),
      box(43, 4, 20, 50),
    ]);
    expect(segments).toEqual([
      { page: 3, lineStart: 41, lineEnd: 42, yTop: 10, yBottom: 70, xLeft: 60, xRight: 560 },
      { page: 4, lineStart: 43, lineEnd: 43, yTop: 20, yBottom: 50, xLeft: 60, xRight: 560 },
    ]);
  });

  it('несмежные строки на одной странице — разные фрагменты', () => {
    expect(groupIntoSegments([box(1, 1, 0, 10), box(5, 1, 50, 60)])).toHaveLength(2);
  });

  it('заголовок перед первой строкой порции входит в её вырезку', () => {
    const segments = groupIntoSegments([
      multi(41, [
        { kind: 'heading', page: 3, yTop: 5, yBottom: 25, xLeft: 60, xRight: 560 },
        { kind: 'text', page: 3, yTop: 30, yBottom: 60, xLeft: 60, xRight: 560 },
      ]),
      box(42, 3, 60, 90),
    ]);
    expect(segments).toEqual([
      { page: 3, lineStart: 41, lineEnd: 42, yTop: 5, yBottom: 90, xLeft: 60, xRight: 560 },
    ]);
  });

  it('абзац на двух страницах — по вырезке на страницу, следующая единица продолжает вторую', () => {
    const segments = groupIntoSegments([
      multi(9, [
        { kind: 'text', page: 19, yTop: 600, yBottom: 700, xLeft: 60, xRight: 560 },
        { kind: 'text', page: 20, yTop: 40, yBottom: 200, xLeft: 60, xRight: 560 },
      ]),
      box(10, 20, 200, 260),
    ]);
    expect(segments).toEqual([
      { page: 19, lineStart: 9, lineEnd: 9, yTop: 600, yBottom: 700, xLeft: 60, xRight: 560 },
      { page: 20, lineStart: 9, lineEnd: 10, yTop: 40, yBottom: 260, xLeft: 60, xRight: 560 },
    ]);
  });
});

describe('segmentPixelRect', () => {
  it('переводит пункты в пиксели по масштабу рендера (200 dpi)', () => {
    const [segment] = groupIntoSegments([box(1, 1, 36, 72)]);
    const rect = segmentPixelRect(
      segment!,
      { widthPt: 595, heightPt: 842 },
      { width: 1653, height: 2339 },
    );
    expect(rect).toEqual({ left: 166, top: 100, width: 1390, height: 101 });
  });

  it('страница целиком в ручном режиме — всё изображение', () => {
    const units = pagesAsUnits([{ page: 2, widthPt: 595, heightPt: 842 }]);
    expect(units[0]).toMatchObject({ lineNumber: 1, page: 2, printedNumber: null });
    const [segment] = groupIntoSegments(units);
    expect(
      segmentPixelRect(segment!, { widthPt: 595, heightPt: 842 }, { width: 827, height: 1170 }),
    ).toEqual({
      left: 0,
      top: 0,
      width: 827,
      height: 1170,
    });
  });
});
