import type { PdfPageWords, PdfWord } from './bbox.js';

// Стратегия «по напечатанным номерам» (CLAUDE.md, раздел 4.1): ищем номера строк в текстовом слое,
// выбираем колонку и самую длинную последовательность, исправляем одиночные сбои нумерации.

export interface NumberToken {
  page: number;
  value: number;
  /** Номер оформлен скобками или знаком: (12), [12], ﴿12﴾, 12., 12- … */
  decorated: boolean;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface NumberedLine {
  /** Итоговый номер по порядку следования. */
  lineNumber: number;
  /** Как напечатано в PDF; null — номер не найден, строка восстановлена по положению. */
  printedNumber: number | null;
  page: number;
  yMin: number;
  yMax: number;
}

export type NumberingAnomaly =
  | { kind: 'misprint'; page: number; lineNumber: number; printed: number }
  | { kind: 'missing_number'; page: number; lineNumber: number }
  | { kind: 'skipped_number'; page: number; afterLine: number; skipped: number[] };

export interface NumberedParse {
  lines: NumberedLine[];
  anomalies: NumberingAnomaly[];
  firstPage: number;
  lastPage: number;
}

export interface DetectOptions {
  /** Меньше строк — результат считается неправдоподобным. */
  minLines: number;
  /** Допуск по горизонтали (пункты) для номеров одной колонки. */
  columnTolerance: number;
  /** Наибольший допустимый скачок напечатанного номера внутри последовательности. */
  maxGap: number;
}

const DEFAULTS: DetectOptions = { minLines: 5, columnTolerance: 20, maxGap: 3 };

/** Сколько следующих номеров просматривать, чтобы признать номер лишним (страница, сноска). */
const NOISE_LOOKAHEAD = 3;

const BRACKETS = '()\\[\\]{}﴾﴿«»<>';
const MARKS = '.\\-–—ـ:';
const NUMBER_TOKEN = new RegExp(
  `^([${MARKS}])?([${BRACKETS}])?(\\d{1,4})([${BRACKETS}])?([${MARKS}])?$`,
);
const FRAGMENT = new RegExp(`^[\\d٠-٩۰-۹${BRACKETS}${MARKS}]+$`);

/** Арабско-индийские (٠-٩) и персидские (۰-۹) цифры → западные. */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x6f0 ? code - 0x6f0 : code - 0x660);
  });
}

export function parseNumberToken(text: string): { value: number; decorated: boolean } | null {
  const match = NUMBER_TOKEN.exec(normalizeDigits(text).replace(/\s+/g, ''));
  if (!match) return null;
  const value = Number(match[3]);
  if (value < 1) return null;
  return { value, decorated: Boolean(match[1] || match[2] || match[4] || match[5]) };
}

/** Склеивает номер, разбитый текстовым слоем на части: «(», «١», «)» → «(١)». */
export function mergeNumberFragments(words: readonly PdfWord[]): PdfWord[] {
  const fragments = words
    .filter((word) => FRAGMENT.test(word.text))
    .sort((a, b) => Math.round(a.yMin / 3) - Math.round(b.yMin / 3) || a.xMin - b.xMin);

  const merged: PdfWord[] = [];
  for (const word of fragments) {
    const last = merged.at(-1);
    const gap = last ? word.xMin - last.xMax : Infinity;
    if (last && Math.abs(word.yMin - last.yMin) <= 3 && gap >= -1 && gap <= 2) {
      merged[merged.length - 1] = {
        text: last.text + word.text,
        xMin: Math.min(last.xMin, word.xMin),
        yMin: Math.min(last.yMin, word.yMin),
        xMax: Math.max(last.xMax, word.xMax),
        yMax: Math.max(last.yMax, word.yMax),
      };
    } else {
      merged.push({ ...word });
    }
  }
  return merged;
}

export function findNumberTokens(page: PdfPageWords): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const word of mergeNumberFragments(page.words)) {
    const parsed = parseNumberToken(word.text);
    if (parsed) tokens.push({ page: page.page, ...parsed, ...boxOf(word) });
  }
  return tokens;
}

function boxOf({ xMin, yMin, xMax, yMax }: PdfWord) {
  return { xMin, yMin, xMax, yMax };
}

/** По какой точке номера выравнивается колонка: по центру, левому или правому краю. */
export type ColumnAnchor = 'center' | 'left' | 'right';

const ANCHORS: readonly ColumnAnchor[] = ['center', 'right', 'left'];

function anchorX(token: NumberToken, anchor: ColumnAnchor): number {
  if (anchor === 'left') return token.xMin;
  if (anchor === 'right') return token.xMax;
  return (token.xMin + token.xMax) / 2;
}

/**
 * Группирует номера по колонкам: жадно берём окно шириной tolerance (по точке выравнивания)
 * с наибольшим числом номеров, затем повторяем для оставшихся. В отличие от «цепочки соседей»,
 * колонка не расползается на всю ширину страницы через номера сносок и страниц.
 * Номера, выровненные по правому краю (١ и ١٠٠ сдвинуты по центру), группируются по anchor = 'right'.
 */
export function clusterByColumn(
  tokens: readonly NumberToken[],
  tolerance: number,
  minSize = 1,
  anchor: ColumnAnchor = 'center',
): NumberToken[][] {
  const remaining = tokens
    .map((token) => ({ token, center: anchorX(token, anchor) }))
    .sort((a, b) => a.center - b.center);
  const clusters: NumberToken[][] = [];
  while (remaining.length > 0) {
    let bestStart = 0;
    let bestEnd = 0;
    for (let start = 0, end = 0; end < remaining.length; end++) {
      while (remaining[end]!.center - remaining[start]!.center > tolerance) start++;
      if (end - start > bestEnd - bestStart) {
        bestStart = start;
        bestEnd = end;
      }
    }
    if (bestEnd - bestStart + 1 < minSize) break;
    clusters.push(remaining.splice(bestStart, bestEnd - bestStart + 1).map((item) => item.token));
  }
  return clusters;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Типичный шаг строк: медиана расстояний между соседними номерами одной страницы,
 * без больших промежутков (заголовки разделов) — берём значения не больше 1,5 × нижний квартиль.
 */
export function estimatePitch(
  items: readonly { page: number; yMin: number; yMax: number }[],
): number {
  const diffs: number[] = [];
  for (let i = 1; i < items.length; i++) {
    const [prev, cur] = [items[i - 1]!, items[i]!];
    if (cur.page === prev.page && cur.yMin > prev.yMin) diffs.push(cur.yMin - prev.yMin);
  }
  if (diffs.length === 0) {
    return median(items.map((item) => item.yMax - item.yMin)) * 1.2 || 1;
  }
  const sorted = [...diffs].sort((a, b) => a - b);
  const lowerQuartile = sorted[Math.floor((sorted.length - 1) * 0.25)]!;
  return median(sorted.filter((diff) => diff <= lowerQuartile * 1.5));
}

const byReadingOrder = (a: NumberToken, b: NumberToken) =>
  a.page - b.page || a.yMin - b.yMin || b.xMax - a.xMax;

/** Делит номера колонки на последовательности; внутри — исправление сбоев нумерации. */
export function splitIntoRuns(
  ordered: readonly NumberToken[],
  pitch: number,
  maxGap: number,
): NumberedParse[] {
  const runs: NumberedParse[] = [];
  let lines: NumberedLine[] = [];
  let anomalies: NumberingAnomaly[] = [];
  let firstValue = 0;
  let lastValue = 0;
  let lastToken: NumberToken | null = null;

  const flush = () => {
    if (lines.length > 0) {
      runs.push({ lines, anomalies, firstPage: lines[0]!.page, lastPage: lines.at(-1)!.page });
    }
    lines = [];
    anomalies = [];
    lastToken = null;
  };

  const addLine = (token: { page: number; yMin: number; yMax: number }, printed: number | null) => {
    const line: NumberedLine = {
      lineNumber: firstValue + lines.length,
      printedNumber: printed,
      page: token.page,
      yMin: token.yMin,
      yMax: token.yMax,
    };
    lines.push(line);
    return line;
  };

  for (let i = 0; i < ordered.length; i++) {
    const token = ordered[i]!;
    const next = ordered[i + 1];

    if (!lastToken) {
      firstValue = token.value;
      lastValue = token.value;
      addLine(token, token.value);
      lastToken = token;
      continue;
    }

    const delta = token.value - lastValue;
    const prevToken: NumberToken = lastToken;

    if (delta === 1) {
      addLine(token, token.value);
      lastValue = token.value;
    } else if (
      ordered.slice(i + 1, i + 1 + NOISE_LOOKAHEAD).some((t) => t.value === lastValue + 1)
    ) {
      const farFromPrevious =
        token.page !== prevToken.page || token.yMin - prevToken.yMin > 2 * pitch;
      if (token.value === lastValue && farFromPrevious) {
        // Тот же номер, но продолжение идёт сразу за этим: лишним был предыдущий (сноска «١» до начала текста).
        lines.pop();
        addLine(token, token.value);
        lastToken = token;
      }
      // Иначе лишний — этот номер (номер страницы, сноска): пропускаем, не прерывая последовательность.
      continue;
    } else if (next && next.value === lastValue + 2) {
      // Одиночная опечатка: соседи согласованы, а этот номер напечатан неверно (276 вместо 286).
      const line = addLine(token, token.value);
      anomalies.push({
        kind: 'misprint',
        page: token.page,
        lineNumber: line.lineNumber,
        printed: token.value,
      });
      lastValue += 1;
    } else if (delta > 1 && delta <= maxGap) {
      const missing = Array.from({ length: delta - 1 }, (_, k) => lastValue + k + 1);
      const distance = token.yMin - prevToken.yMin;
      if (token.page === prevToken.page && distance >= (delta - 0.5) * pitch) {
        // Номер(а) не распознаны, но место под строки есть — восстанавливаем строки по положению.
        const height = token.yMax - token.yMin;
        missing.forEach((_, k) => {
          const yMin = prevToken.yMin + (distance * (k + 1)) / delta;
          const line = addLine({ page: token.page, yMin, yMax: yMin + height }, null);
          anomalies.push({ kind: 'missing_number', page: token.page, lineNumber: line.lineNumber });
        });
      } else {
        anomalies.push({
          kind: 'skipped_number',
          page: token.page,
          afterLine: lines.at(-1)!.lineNumber,
          skipped: missing,
        });
      }
      addLine(token, token.value);
      lastValue = token.value;
    } else {
      flush();
      firstValue = token.value;
      lastValue = token.value;
      addLine(token, token.value);
    }
    lastToken = token;
  }
  flush();
  return runs;
}

/** Самая длинная правдоподобная последовательность номеров во всём документе или null. */
export function detectNumberedLines(
  pages: readonly PdfPageWords[],
  options: Partial<DetectOptions> = {},
): NumberedParse | null {
  const opts = { ...DEFAULTS, ...options };
  const tokens = pages.flatMap(findNumberTokens);

  let best: NumberedParse | null = null;
  for (const anchor of ANCHORS) {
    for (const column of clusterByColumn(tokens, opts.columnTolerance, opts.minLines, anchor)) {
      const ordered = [...column].sort(byReadingOrder);
      const pitch = estimatePitch(ordered);
      for (const run of splitIntoRuns(ordered, pitch, opts.maxGap)) {
        if (run.lines.length >= opts.minLines && run.lines.length > (best?.lines.length ?? 0)) {
          best = run;
        }
      }
    }
  }
  return best;
}
