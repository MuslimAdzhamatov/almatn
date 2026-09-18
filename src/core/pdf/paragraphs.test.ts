import { describe, expect, it } from 'vitest';
import type { ClassifiedBand, PageBands } from './imagelines.js';
import { dropFootnotes, paragraphsToBoxes, splitEvenly } from './paragraphs.js';

const WIDTH = 800;
const HEIGHT = 1000;

/** Строка текста: полная во всю ширину набора или короткая (последняя в абзаце). */
const line = (
  top: number,
  { short = false, height = 30, kind = 'text' as ClassifiedBand['kind'] } = {},
): ClassifiedBand => ({
  top,
  bottom: top + height - 1,
  maxInk: 200,
  xMin: short ? 400 : 100,
  xMax: 700,
  kind,
});

const page = (pageNumber: number, bands: ClassifiedBand[]): PageBands => ({
  page: pageNumber,
  width: WIDTH,
  height: HEIGHT,
  widthPt: WIDTH / 2,
  heightPt: HEIGHT / 2,
  bands,
});

describe('dropFootnotes', () => {
  it('отсекает хвост страницы, набранный мельче основного текста', () => {
    const pages = [
      page(1, [
        line(100),
        line(140),
        line(180, { short: true }),
        // сноски: строки в полтора раза ниже
        line(600, { height: 18 }),
        line(625, { height: 18 }),
        line(650, { height: 18 }),
      ]),
      page(2, [line(100), line(140), line(180, { short: true })]),
    ];
    const cleaned = dropFootnotes(pages);
    expect(cleaned[0]?.bands).toHaveLength(3);
    expect(cleaned[0]?.bands.every((band) => band.top < 600)).toBe(true);
    expect(cleaned[1]?.bands).toHaveLength(3);
  });

  it('мелкая строка в середине текста абзацы не ломает', () => {
    const pages = [
      page(1, [line(100), line(140, { height: 18 }), line(180), line(220, { short: true })]),
      page(2, [line(100), line(140), line(180, { short: true })]),
    ];
    expect(dropFootnotes(pages)[0]?.bands).toHaveLength(4);
  });
});

describe('paragraphsToBoxes', () => {
  it('абзац заканчивается короткой строкой, нумерация идёт подряд', () => {
    const boxes = paragraphsToBoxes([
      page(1, [
        line(100),
        line(140),
        line(180, { short: true }),
        line(220),
        line(260, { short: true }),
        line(300),
        line(340),
        line(380, { short: true }),
      ]),
    ]);
    expect(boxes?.map((box) => box.lineNumber)).toEqual([1, 2, 3]);
    expect(boxes?.[0]?.fragments).toHaveLength(1);
    // Масштаб 0,5: строки 100..209 пикселей плюс отступ в два пикселя.
    expect(boxes?.[0]?.fragments[0]).toMatchObject({ page: 1, yTop: 49, yBottom: 105.5 });
  });

  it('абзац с переходом на следующую страницу — по фрагменту на страницу', () => {
    const boxes = paragraphsToBoxes([
      page(1, [line(100), line(140), line(180, { short: true }), line(900)]),
      page(2, [line(100), line(140, { short: true }), line(200), line(240, { short: true })]),
    ]);
    expect(boxes).toHaveLength(3);
    const crossing = boxes![1]!;
    expect(crossing.fragments.map((fragment) => fragment.page)).toEqual([1, 2]);
    expect(crossing.page).toBe(1);
  });

  it('заголовок закрывает абзац и попадает в картинку следующего', () => {
    const boxes = paragraphsToBoxes([
      page(1, [
        line(100),
        line(140, { short: true }),
        // Заголовок центрирован: отступы с обеих сторон набора (100..700).
        { ...line(200), xMin: 300, xMax: 500 },
        line(260),
        line(300, { short: true }),
        line(340),
        line(380, { short: true }),
      ]),
    ]);
    expect(boxes).toHaveLength(3);
    expect(boxes?.[1]?.fragments.map((fragment) => fragment.kind)).toEqual(['heading', 'text']);
    expect(boxes?.[1]).toMatchObject({ lineNumber: 2, sectionBreakBefore: true });
  });

  it('стихи — не проза: строки выключены по обоим краям, абзац не выделяется', () => {
    const verses = page(
      1,
      Array.from({ length: 12 }, (_, i) => line(100 + i * 40)),
    );
    // Ни одной короткой строки — весь текст стал бы одним абзацем, значит стратегия не подходит.
    expect(paragraphsToBoxes([verses])).toBeNull();
  });

  it('короткая строка абзаца прижата к краю и заголовком не считается', () => {
    const boxes = paragraphsToBoxes([
      page(1, [
        line(100),
        line(140, { short: true }),
        line(180),
        line(220, { short: true }),
        line(260),
        line(300, { short: true }),
      ]),
    ]);
    expect(boxes).toHaveLength(3);
    expect(boxes?.every((box) => box.fragments.every((f) => f.kind === 'text'))).toBe(true);
  });

  it('текста слишком мало — null', () => {
    expect(paragraphsToBoxes([page(1, [line(100), line(140, { short: true })])])).toBeNull();
    expect(paragraphsToBoxes([page(1, [])])).toBeNull();
  });
});

describe('splitEvenly', () => {
  it('делит на ровные части, а не на «по максимуму и огрызок»', () => {
    expect(splitEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5).map((p) => p.length)).toEqual([
      4, 4, 4,
    ]);
    expect(splitEvenly([1, 2, 3, 4, 5, 6, 7], 5).map((p) => p.length)).toEqual([4, 3]);
  });

  it('короткое не делит', () => {
    expect(splitEvenly([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
    expect(splitEvenly([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it('части идут по порядку и ничего не теряют', () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const parts = splitEvenly(items, 4);
    expect(parts.flat()).toEqual(items);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(4);
  });
});

describe('деление длинных абзацев', () => {
  /** Абзац из nLines строк, последняя короткая. */
  const paragraph = (top: number, nLines: number) =>
    Array.from({ length: nLines }, (_, i) => line(top + i * 40, { short: i === nLines - 1 }));

  it('длинный абзац делится на части, короткий остаётся целым', () => {
    const pages = [page(1, [...paragraph(100, 7), ...paragraph(500, 3), ...paragraph(700, 3)])];
    expect(paragraphsToBoxes(pages)?.length).toBe(3);

    const split = paragraphsToBoxes(pages, { maxLinesPerUnit: 4 });
    // 7 строк по 4 → две части (4+3), короткие абзацы не тронуты.
    expect(split).toHaveLength(4);
    expect(split?.map((box) => box.lineNumber)).toEqual([1, 2, 3, 4]);
    // Части идут подряд и не перекрываются.
    const [first, second] = split!;
    expect(first!.fragments[0]!.yBottom).toBeLessThan(second!.fragments[0]!.yTop);
  });

  it('заголовок остаётся у первой части делёного абзаца', () => {
    const boxes = paragraphsToBoxes(
      [
        page(1, [
          ...paragraph(100, 3),
          { ...line(300), xMin: 300, xMax: 500 },
          ...paragraph(360, 6),
          ...paragraph(700, 3),
        ]),
      ],
      { maxLinesPerUnit: 3 },
    );
    // Абзац из 6 строк стал двумя частями; заголовок ушёл в первую из них.
    expect(boxes).toHaveLength(4);
    expect(boxes?.[1]?.sectionBreakBefore).toBe(true);
    expect(boxes?.[2]?.sectionBreakBefore).toBe(false);
  });

  it('деление не мешает признать текст прозой', () => {
    // Одна строка на абзац — это стихи: стратегия не применяется и с делением тоже.
    const pages = [
      page(
        1,
        Array.from({ length: 8 }, (_, i) => line(100 + i * 40, { short: true })),
      ),
    ];
    expect(paragraphsToBoxes(pages, { maxLinesPerUnit: 2 })).toBeNull();
  });
});
