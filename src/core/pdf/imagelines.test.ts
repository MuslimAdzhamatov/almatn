import { describe, expect, it } from 'vitest';
import { inkPerRow, type GrayImage } from './layout.js';
import {
  dropRunningBands,
  imageLinesToBoxes,
  inkBands,
  refineBands,
  typicalHeight,
  typicalWidth,
  type ClassifiedBand,
  type PageBands,
} from './imagelines.js';

const WIDTH = 400;
const HEIGHT = 600;

/** Белое изображение с чёрными прямоугольниками [сверху, снизу, слева, справа]. */
function image(rects: [number, number, number, number][]): GrayImage {
  const data = new Uint8Array(WIDTH * HEIGHT).fill(255);
  for (const [top, bottom, left, right] of rects) {
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= Math.min(right, WIDTH - 1); x++) data[y * WIDTH + x] = 0;
  }
  return { width: WIDTH, height: HEIGHT, data };
}

/**
 * Строка текста: «слова» по 12 пикселей с пробелами. Сплошной прямоугольник не годится —
 * у настоящей строки тёмные пиксели не заполняют ширину подряд, и по этому она отличается от линии.
 */
function words(
  top: number,
  { height = 20, left = 40, right = 360 } = {},
): [number, number, number, number][] {
  const rects: [number, number, number, number][] = [];
  for (let x = left; x + 12 <= right; x += 20) rects.push([top, top + height - 1, x, x + 11]);
  return rects;
}

function analyse(rects: [number, number, number, number][]) {
  const img = image(rects);
  const rows = inkPerRow(img);
  const bands = inkBands(img, rows);
  const height = typicalHeight(bands, 0.4);
  return refineBands(bands, rows, {
    height,
    width: typicalWidth(bands, height),
    imageWidth: img.width,
  });
}

describe('inkBands', () => {
  it('находит полосы между пустыми промежутками и запоминает самую тёмную строку', () => {
    const bands = inkBands(image([...words(50), [100, 101, 0, 399]]));
    expect(bands).toHaveLength(2);
    expect(bands[0]).toMatchObject({ top: 50, bottom: 69, xMin: 40, xMax: 351 });
    expect(bands[1]).toMatchObject({ top: 100, bottom: 101, maxInk: 400 });
  });
});

describe('refineBands', () => {
  it('сплошную линию помечает как рамку, а не строку', () => {
    const bands = analyse([
      ...words(50),
      ...words(90),
      ...words(130),
      [180, 181, 0, 399], // линия рамки во всю ширину
      ...words(200),
    ]);
    expect(bands.filter((b) => b.kind === 'rule')).toHaveLength(1);
    expect(bands.filter((b) => b.kind === 'text')).toHaveLength(4);
  });

  it('тонкую тёмную черту над сносками тоже считает линией', () => {
    const bands = analyse([
      ...words(50),
      ...words(90),
      ...words(130),
      [180, 183, 40, 220], // черта над сносками: тонкая и сплошная
      ...words(200),
    ]);
    expect(bands.filter((b) => b.kind === 'rule')).toHaveLength(1);
  });

  it('огласовку присоединяет к своей строке, а не считает отдельной', () => {
    const bands = analyse([...words(50), [72, 74, 160, 190], ...words(90), ...words(130)]);
    expect(bands).toHaveLength(3);
    expect(bands[0]).toMatchObject({ top: 50, bottom: 74 });
  });

  it('слипшиеся строки делит по самому светлому месту', () => {
    const bands = analyse([
      ...words(50),
      ...words(90),
      ...words(130),
      [150, 151, 200, 204], // перемычка между двумя строками
      ...words(152),
      ...words(200),
    ]);
    expect(bands).toHaveLength(5);
    expect(bands[2]?.bottom).toBeLessThan(152);
    expect(bands[3]?.top).toBeGreaterThan(149);
  });

  it('узкую полосу считает заголовком раздела', () => {
    const bands = analyse([
      ...words(50),
      ...words(90, { left: 150, right: 250 }),
      ...words(130),
      ...words(170),
    ]);
    expect(bands.map((b) => b.kind)).toEqual(['text', 'heading', 'text', 'text']);
  });
});

describe('dropRunningBands', () => {
  const band = (
    top: number,
    xMin: number,
    xMax: number,
    kind: ClassifiedBand['kind'] = 'text',
  ): ClassifiedBand => ({ top, bottom: top + 19, maxInk: 100, xMin, xMax, kind });

  const pages = (count: number): PageBands[] =>
    Array.from({ length: count }, (_, i) => ({
      page: i + 1,
      width: WIDTH,
      height: HEIGHT,
      widthPt: WIDTH,
      heightPt: HEIGHT,
      bands: [
        band(10, 160, 240, 'heading'), // колонтитул: узкий, вверху, на каждой странице
        band(2, 0, 399, 'rule'), // линия рамки
        band(100, 40, 360),
        band(140, 40, 360),
        band(300, 40, 360), // в середине страницы — не колонтитул
      ],
    }));

  it('убирает повторяющийся колонтитул и линии рамки', () => {
    const cleaned = dropRunningBands(pages(4), 20);
    for (const page of cleaned) {
      expect(page.bands).toHaveLength(3);
      expect(page.bands.every((b) => b.kind !== 'rule' && b.top !== 10)).toBe(true);
    }
  });

  it('одиночную полосу у края колонтитулом не считает', () => {
    const only = pages(4);
    for (const page of only.slice(1)) page.bands = page.bands.filter((b) => b.top !== 10);
    expect(dropRunningBands(only, 20)[0]!.bands.some((b) => b.top === 10)).toBe(true);
  });
});

describe('imageLinesToBoxes', () => {
  const page = (pageNumber: number, bands: ClassifiedBand[]): PageBands => ({
    page: pageNumber,
    width: WIDTH,
    height: HEIGHT,
    widthPt: WIDTH / 2,
    heightPt: HEIGHT / 2,
    bands,
  });
  const text = (top: number): ClassifiedBand => ({
    top,
    bottom: top + 19,
    maxInk: 100,
    xMin: 40,
    xMax: 360,
    kind: 'text',
  });

  it('нумерует строки подряд и переводит пиксели в пункты', () => {
    const boxes = imageLinesToBoxes([page(3, [text(50), text(90)]), page(4, [text(50), text(90)])]);
    expect(boxes.map((b) => b.lineNumber)).toEqual([1, 2, 3, 4]);
    // Масштаб 0,5: строка 50..69 пикселей плюс отступ в пиксель → 24,5 пункта.
    expect(boxes[0]?.fragments[0]?.yTop).toBeCloseTo(24.5, 1);
    expect(boxes[0]?.fragments[0]?.xLeft).toBe(20);
    expect(boxes[2]?.page).toBe(4);
  });

  it('обложку и пустые страницы отбрасывает', () => {
    const boxes = imageLinesToBoxes([
      page(1, [text(50)]),
      page(2, []),
      page(3, [text(50), text(90), text(130)]),
      page(4, [text(50), text(90), text(130)]),
    ]);
    expect(boxes).toHaveLength(6);
    expect(boxes.every((box) => box.page >= 3)).toBe(true);
  });

  it('последнюю неполную страницу книги не теряет', () => {
    const boxes = imageLinesToBoxes([
      page(1, [text(50), text(90), text(130), text(170)]),
      page(2, [text(50), text(90), text(130), text(170)]),
      page(3, [text(50)]), // концовка: одна строка и колофон
    ]);
    expect(boxes).toHaveLength(9);
    expect(boxes.at(-1)?.page).toBe(3);
  });

  it('страницу из одних рамок текстом не считает', () => {
    const frame: ClassifiedBand = { ...text(50), kind: 'heading' };
    const boxes = imageLinesToBoxes([
      page(1, [frame, { ...frame, top: 90 }, { ...frame, top: 130 }]),
      page(2, [text(50), text(90), text(130)]),
      page(3, [text(50), text(90), text(130)]),
    ]);
    expect(boxes.every((box) => box.page >= 2)).toBe(true);
  });

  it('заголовок становится фрагментом следующей строки', () => {
    const heading: ClassifiedBand = { ...text(50), xMin: 150, xMax: 250, kind: 'heading' };
    const boxes = imageLinesToBoxes([
      page(3, [heading, text(90), text(130), text(170)]),
      page(4, [text(50), text(90), text(130)]),
    ]);
    expect(boxes[0]).toMatchObject({ lineNumber: 1, sectionBreakBefore: true });
    expect(boxes[0]?.fragments.map((f) => f.kind)).toEqual(['heading', 'text']);
    expect(boxes).toHaveLength(6);
  });
});
