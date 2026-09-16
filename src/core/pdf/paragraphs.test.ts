import { describe, expect, it } from 'vitest';
import type { ClassifiedBand, PageBands } from './imagelines.js';
import { dropFootnotes, paragraphsToBoxes } from './paragraphs.js';

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
