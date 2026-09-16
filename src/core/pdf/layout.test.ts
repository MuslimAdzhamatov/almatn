import { describe, expect, it } from 'vitest';
import { inkColumnRange, inkPerRow, layoutNumberedLines, type GrayImage } from './layout.js';
import type { NumberedLine } from './numbers.js';

/** Белое изображение 100×200 (масштаб 1: 1 px = 1 pt) с чёрными прямоугольниками. */
function image(rects: [top: number, bottom: number, left: number, right: number][]): GrayImage {
  const width = 100;
  const height = 200;
  const data = new Uint8Array(width * height).fill(255);
  for (const [top, bottom, left, right] of rects) {
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) data[y * width + x] = 0;
  }
  return { width, height, data };
}

const line = (lineNumber: number, yMin: number, yMax: number): NumberedLine => ({
  lineNumber,
  printedNumber: lineNumber,
  page: 1,
  yMin,
  yMax,
});

describe('профиль чернил', () => {
  it('считает тёмные пиксели по строкам и находит ширину текста', () => {
    const img = image([[10, 12, 20, 29]]);
    const rows = inkPerRow(img);
    expect([rows[9], rows[10], rows[12], rows[13]]).toEqual([0, 10, 10, 0]);
    expect(inkColumnRange(img, 0, 200)).toEqual([20, 29]);
    expect(inkColumnRange(img, 50, 60)).toBeNull();
  });
});

describe('layoutNumberedLines', () => {
  const page = image([
    [10, 30, 20, 80], // строка 1
    [35, 55, 25, 75], // строка 2
    [57, 58, 40, 45], // харакаты под строкой 2
    [90, 110, 30, 70], // заголовок раздела
    [130, 150, 22, 78], // строка 3
  ]);
  const boxes = layoutNumberedLines(
    [line(1, 8, 31), line(2, 33, 56), line(3, 128, 151)],
    new Map([[1, { page: 1, widthPt: 100, heightPt: 200, image: page }]]),
  );

  /** У строки один фрагмент — сама строка. */
  const frag = (index: number) => boxes[index]?.fragments[0];

  it('делит соседние строки посередине пустой полосы между ними', () => {
    expect(boxes[0]).toMatchObject({ sectionBreakBefore: false });
    expect(frag(0)).toMatchObject({ kind: 'text', page: 1, yTop: 7, yBottom: 33 });
    expect(frag(1)?.yTop).toBe(33);
  });

  it('оставляет харакаты со своей строкой и не захватывает заголовок', () => {
    expect(frag(1)?.yBottom).toBe(61);
    expect(boxes[2]).toMatchObject({ sectionBreakBefore: true });
    expect(frag(2)).toMatchObject({ yTop: 127, yBottom: 153 });
  });

  it('ширина вырезки — текстовый блок страницы с полями', () => {
    for (const box of boxes) expect(box.fragments[0]).toMatchObject({ xLeft: 14, xRight: 87 });
  });
});
