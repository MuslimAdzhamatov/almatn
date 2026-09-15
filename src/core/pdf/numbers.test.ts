import { describe, expect, it } from 'vitest';
import type { PdfPageWords, PdfWord } from './bbox.js';
import {
  clusterByColumn,
  detectNumberedLines,
  estimatePitch,
  mergeNumberFragments,
  normalizeDigits,
  parseNumberToken,
  type NumberToken,
} from './numbers.js';

const ARABIC = '٠١٢٣٤٥٦٧٨٩';
const toArabic = (n: number) => String(n).replace(/\d/g, (d) => ARABIC[Number(d)]!);

function word(text: string, xMin: number, yMin: number, width = 20, height = 25): PdfWord {
  return { text, xMin, yMin, xMax: xMin + width, yMax: yMin + height };
}

/** Страница «как манзума»: номера в скобках справа, мусор из текстового слоя, номер страницы внизу. */
function page(
  pageNo: number,
  numbers: (number | null)[],
  opts: { startY?: number; pitch?: number; bare?: boolean } = {},
): PdfPageWords {
  const { startY = 30, pitch = 30, bare = false } = opts;
  const words: PdfWord[] = [];
  numbers.forEach((n, i) => {
    const y = startY + i * pitch;
    if (n !== null) words.push(word(bare ? toArabic(n) : `(${toArabic(n)})`, 523, y));
    words.push(word('%', 245, y + 1, 8), word('ﺔﻴﻄﳋا', 380, y + 1, 40));
  });
  words.push(word(toArabic(pageNo), 290, 815, 10));
  return { page: pageNo, width: 595, height: 842, words };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('номера строк', () => {
  it('нормализует арабско-индийские и персидские цифры', () => {
    expect(normalizeDigits('(٢٧٦) ۱۲ 7')).toBe('(276) 12 7');
  });

  it.each([
    ['(١٢)', 12, true],
    ['١٢', 12, false],
    ['۱۲', 12, false],
    ['12.', 12, true],
    ['12-', 12, true],
    ['12)', 12, true],
    ['[7]', 7, true],
    ['﴿3﴾', 3, true],
    [')٥(', 5, true],
    ['ـ٥٤', 54, true],
  ])('распознаёт %j как %i', (text, value, decorated) => {
    expect(parseNumberToken(text)).toEqual({ value, decorated });
  });

  it.each(['0', '(٠)', 'abc', '12345', '1a', ''])('не считает номером %j', (text) => {
    expect(parseNumberToken(text)).toBeNull();
  });

  it('склеивает номер, разбитый на скобки и цифры', () => {
    const merged = mergeNumberFragments([
      word('(', 385.9, 58.7, 3.2),
      word('١', 389.16, 58.7, 5.3),
      word(')', 394.44, 58.7, 3.2),
      word('ﺔﻴﻄﳋا', 397.7, 60.3, 28),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: '(١)', xMin: 385.9 });
  });

  it('оценивает шаг строк без учёта заголовков разделов', () => {
    const lines = [30, 60, 90, 223, 253, 283, 313].map((yMin) => ({
      page: 1,
      yMin,
      yMax: yMin + 25,
    }));
    expect(estimatePitch(lines)).toBe(30);
  });

  it('колонка — окно наибольшей плотности, соседние номера не сцепляются в одну колонку', () => {
    const token = (center: number): NumberToken => ({
      page: 1,
      value: 1,
      decorated: false,
      xMin: center - 5,
      xMax: center + 5,
      yMin: 0,
      yMax: 10,
    });
    const clusters = clusterByColumn([533, 535, 531, 515, 497, 479, 481].map(token), 20);
    expect(clusters.map((cluster) => cluster.length)).toEqual([4, 3]);
    expect(clusterByColumn([533, 535, 531, 497].map(token), 20, 2)).toHaveLength(1);
  });
});

describe('detectNumberedLines', () => {
  it('находит последовательность и игнорирует номера страниц и мусор', () => {
    const result = detectNumberedLines([page(1, range(1, 9)), page(2, range(10, 18))]);
    expect(result?.lines).toHaveLength(18);
    expect(result?.lines[0]).toMatchObject({ lineNumber: 1, printedNumber: 1, page: 1 });
    expect(result?.lines.at(-1)).toMatchObject({ lineNumber: 18, printedNumber: 18, page: 2 });
    expect(result).toMatchObject({ anomalies: [], firstPage: 1, lastPage: 2 });
  });

  it('исправляет одиночную опечатку в номере (276 вместо 286)', () => {
    const printed = range(280, 290).map((n) => (n === 286 ? 276 : n));
    const result = detectNumberedLines([page(21, printed)]);
    expect(result?.lines.map((l) => l.lineNumber)).toEqual(range(280, 290));
    expect(result?.lines.find((l) => l.lineNumber === 286)?.printedNumber).toBe(276);
    expect(result?.anomalies).toEqual([
      { kind: 'misprint', page: 21, lineNumber: 286, printed: 276 },
    ]);
  });

  it('восстанавливает строку, у которой номер не распознан', () => {
    const result = detectNumberedLines([page(1, [1, 2, 3, null, 5, 6, 7])]);
    expect(result?.lines).toHaveLength(7);
    expect(result?.lines[3]).toMatchObject({ lineNumber: 4, printedNumber: null, yMin: 120 });
    expect(result?.anomalies).toEqual([{ kind: 'missing_number', page: 1, lineNumber: 4 }]);
  });

  it('пропуск в нумерации без пропуска строки — нумерует по порядку', () => {
    const result = detectNumberedLines([page(1, [1, 2, 3, 4, 5, 7, 8, 9])]);
    expect(result?.lines.map((l) => [l.lineNumber, l.printedNumber])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 7],
      [7, 8],
      [8, 9],
    ]);
    expect(result?.anomalies).toEqual([
      { kind: 'skipped_number', page: 1, afterLine: 5, skipped: [6] },
    ]);
  });

  it('при повторной нумерации (текст, затем разбор) выбирает самую длинную последовательность', () => {
    const result = detectNumberedLines([
      page(8, range(1, 12), { bare: true }),
      page(9, range(13, 20), { bare: true }),
      page(10, [1, 2, 3, 4, 5, 6], { bare: true }),
      page(11, [1, 2, 3, 4, 5, 6], { bare: true }),
    ]);
    expect(result).toMatchObject({ firstPage: 8, lastPage: 9 });
    expect(result?.lines).toHaveLength(20);
  });

  it('пропускает номер страницы, попавший в колонку номеров строк', () => {
    const withPageNumberInColumn = (pageNo: number, numbers: number[]): PdfPageWords => {
      const result = page(pageNo, numbers, { bare: true });
      result.words.push(word(toArabic(pageNo), 523, 815));
      return result;
    };
    const result = detectNumberedLines([
      withPageNumberInColumn(7, range(1, 12)),
      withPageNumberInColumn(8, range(13, 24)),
    ]);
    expect(result?.lines.map((l) => l.printedNumber)).toEqual(range(1, 24));
    expect(result?.anomalies).toEqual([]);
  });

  it('сноска с тем же номером до начала текста не сдвигает начало последовательности', () => {
    const intro = page(5, [], { bare: true });
    intro.words.push(word(toArabic(1), 523, 552)); // сноска «١» внизу страницы предисловия
    const result = detectNumberedLines([intro, page(8, range(1, 12), { bare: true })]);
    expect(result).toMatchObject({ firstPage: 8, lastPage: 8, anomalies: [] });
    expect(result?.lines[0]).toMatchObject({ lineNumber: 1, printedNumber: 1, page: 8, yMin: 30 });
    expect(result?.lines).toHaveLength(12);
  });

  it('слишком мало номеров — не считает результат правдоподобным', () => {
    expect(detectNumberedLines([page(1, [1, 2, 3, 4])])).toBeNull();
    expect(detectNumberedLines([{ page: 1, width: 595, height: 842, words: [] }])).toBeNull();
  });
});
