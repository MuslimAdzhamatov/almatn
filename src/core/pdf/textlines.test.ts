import { describe, expect, it } from 'vitest';
import type { PdfPageWords, PdfWord } from './bbox.js';
import type { LineBox } from './layout.js';
import {
  attachHeadings,
  detectTextLines,
  findRunningLines,
  groupWordsIntoLines,
} from './textlines.js';

const word = (text: string, yMin: number, yMax: number, xMin = 100, xMax = 400): PdfWord => ({
  text,
  xMin,
  xMax,
  yMin,
  yMax,
});

/** Страница с ровными строками через шаг pitch. */
function page(
  pageNumber: number,
  count: number,
  { pitch = 30, top = 60, height = 25, footer = true } = {},
): PdfPageWords {
  const words: PdfWord[] = [];
  for (let i = 0; i < count; i++) {
    const y = top + i * pitch;
    words.push(word(`слово-${i}`, y, y + height));
    // Огласовки идут отдельными «словами» со сдвигом — должны попасть в ту же строку.
    words.push(word('َ', y + 5, y + height - 2, 150, 160));
  }
  if (footer) words.push(word(String(pageNumber), 800, 811, 290, 300));
  return { page: pageNumber, width: 595, height: 842, words };
}

describe('groupWordsIntoLines', () => {
  it('собирает слово и его огласовки в одну строку', () => {
    const lines = groupWordsIntoLines(page(1, 3, { footer: false }));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ page: 1, yMin: 60, yMax: 85, words: 2 });
  });

  it('не склеивает строки, стоящие вплотную', () => {
    const lines = groupWordsIntoLines({
      page: 1,
      width: 595,
      height: 842,
      words: [word('а', 100, 125), word('б', 126, 151)],
    });
    expect(lines).toHaveLength(2);
  });

  it('пропускает пустые слова', () => {
    const lines = groupWordsIntoLines({
      page: 1,
      width: 595,
      height: 842,
      words: [word(' ', 100, 125), word('а', 200, 225)],
    });
    expect(lines).toHaveLength(1);
  });
});

describe('findRunningLines', () => {
  it('находит номер страницы, повторяющийся внизу каждой страницы', () => {
    const pages = [1, 2, 3, 4].map((n) => page(n, 10));
    const perPage = pages.map((p) => ({
      page: p.page,
      height: p.height,
      lines: groupWordsIntoLines(p),
    }));
    const running = findRunningLines(perPage);
    expect(running.size).toBe(4);
    for (const line of running) expect(line.yMin).toBe(800);
  });

  it('первую строку страницы у верхнего поля колонтитулом не считает — она во всю ширину', () => {
    const pages = [1, 2, 3, 4].map((n) => page(n, 10, { top: 20 }));
    const perPage = pages.map((p) => ({
      page: p.page,
      height: p.height,
      lines: groupWordsIntoLines(p),
    }));
    const running = findRunningLines(perPage);
    expect(running.size).toBe(4);
    for (const line of running) expect(line.yMin).toBe(800);
  });

  it('строку в середине страницы колонтитулом не считает', () => {
    const pages = [1, 2, 3, 4].map((n) => page(n, 10, { footer: false }));
    const perPage = pages.map((p) => ({
      page: p.page,
      height: p.height,
      lines: groupWordsIntoLines(p),
    }));
    expect(findRunningLines(perPage).size).toBe(0);
  });
});

describe('detectTextLines', () => {
  it('нумерует строки подряд через весь документ, без колонтитулов', () => {
    const parse = detectTextLines([page(1, 12), page(2, 12), page(3, 12)]);
    expect(parse?.lines).toHaveLength(36);
    expect(parse).toMatchObject({ firstPage: 1, lastPage: 3 });
    expect(parse?.lines.every((line) => line.yMin < 800)).toBe(true);
  });

  it('обложку и колофон в текст не берёт', () => {
    const cover: PdfPageWords = {
      page: 1,
      width: 595,
      height: 842,
      words: [word('НАЗВАНИЕ', 300, 360, 150, 450)],
    };
    const parse = detectTextLines([cover, page(2, 12), page(3, 12), page(4, 1)]);
    expect(parse).toMatchObject({ firstPage: 2, lastPage: 3 });
    expect(parse?.lines).toHaveLength(24);
  });

  it('заголовок раздела не считается строкой и привязывается к следующей', () => {
    const withHeading: PdfPageWords = {
      ...page(2, 12),
      words: [...page(2, 12).words, word('باب الصلاة', 430, 475, 200, 380)],
    };
    const parse = detectTextLines([page(1, 12), withHeading, page(3, 12)]);
    expect(parse?.headings).toHaveLength(1);
    const [heading] = parse!.headings;
    expect(heading?.line.yMin).toBe(430);
    // Заголовок стоит внизу второй страницы, поэтому относится к первой строке третьей.
    expect(heading?.beforeLine).toBe(25);
    expect(parse?.lines[24]).toMatchObject({ page: 3, yMin: 60 });
    expect(parse?.lines).toHaveLength(36);
  });

  it('текстового слоя почти нет — null', () => {
    expect(detectTextLines([page(1, 2, { footer: false })])).toBeNull();
    expect(detectTextLines([])).toBeNull();
  });

  it('битый текстовый слой: заголовком выглядит больше трети строк — null', () => {
    const jumpy: PdfPageWords = {
      page: 1,
      width: 595,
      height: 842,
      // Высоты скачут, как в PDF со сломанными шрифтами.
      words: Array.from({ length: 20 }, (_, i) =>
        word(`w${i}`, 60 + i * 35, 60 + i * 35 + (i % 2 ? 30 : 10)),
      ),
    };
    expect(detectTextLines([jumpy, { ...jumpy, page: 2 }])).toBeNull();
  });
});

describe('attachHeadings', () => {
  const unit = (lineNumber: number, page: number, yTop: number, yBottom: number): LineBox => ({
    lineNumber,
    printedNumber: null,
    page,
    sectionBreakBefore: false,
    fragments: [{ kind: 'text', page, yTop, yBottom, xLeft: 60, xRight: 560 }],
  });

  it('заголовок становится фрагментом следующей единицы, нумерация идёт подряд', () => {
    const units = attachHeadings(
      [unit(1, 1, 10, 40), unit(2, 1, 50, 80), unit(3, 1, 90, 120)],
      [false, true, false],
    );
    expect(units).toHaveLength(2);
    expect(units[1]).toMatchObject({ lineNumber: 2, page: 1, sectionBreakBefore: true });
    expect(units[1]?.fragments).toEqual([
      { kind: 'heading', page: 1, yTop: 50, yBottom: 80, xLeft: 60, xRight: 560 },
      { kind: 'text', page: 1, yTop: 90, yBottom: 120, xLeft: 60, xRight: 560 },
    ]);
  });

  it('два заголовка подряд входят оба, а заголовок с прошлой страницы сохраняет свою', () => {
    const units = attachHeadings(
      [unit(1, 2, 700, 730), unit(2, 2, 740, 770), unit(3, 3, 40, 70)],
      [true, true, false],
    );
    expect(units).toHaveLength(1);
    expect(units[0]?.fragments.map((f) => `${f.kind}:${f.page}`)).toEqual([
      'heading:2',
      'heading:2',
      'text:3',
    ]);
  });

  it('заголовок в самом конце ни к чему не привязывается', () => {
    expect(attachHeadings([unit(1, 1, 10, 40), unit(2, 1, 50, 80)], [false, true])).toHaveLength(1);
  });
});
