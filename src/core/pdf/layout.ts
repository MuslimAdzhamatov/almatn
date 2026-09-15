import { estimatePitch, type NumberedLine } from './numbers.js';

// Границы строк для вырезки (CLAUDE.md, раздел 4.1, «Вырезка порций»): стартовая оценка — по номерам,
// уточнение — по горизонтальному профилю тёмных пикселей отрендеренной страницы,
// чтобы не резать харакаты и не захватывать соседние строки и заголовки разделов.

export interface GrayImage {
  width: number;
  height: number;
  /** Яркость пикселей построчно, 0 — чёрный, 255 — белый. */
  data: Uint8Array;
}

export interface PageRaster {
  page: number;
  widthPt: number;
  heightPt: number;
  image: GrayImage;
}

export interface LineBox {
  lineNumber: number;
  printedNumber: number | null;
  page: number;
  /** Границы вырезки в пунктах PDF. */
  yTop: number;
  yBottom: number;
  /** null — вся ширина страницы. */
  xLeft: number | null;
  xRight: number | null;
  sectionBreakBefore: boolean;
}

/** Пиксель темнее этого значения считается «чернилами». */
export const INK_LEVEL = 160;

export function inkPerRow(image: GrayImage): Uint32Array {
  const rows = new Uint32Array(image.height);
  for (let y = 0; y < image.height; y++) {
    let ink = 0;
    const offset = y * image.width;
    for (let x = 0; x < image.width; x++) if (image.data[offset + x]! < INK_LEVEL) ink++;
    rows[y] = ink;
  }
  return rows;
}

/** Первый и последний столбец с чернилами в полосе строк [top, bottom). */
export function inkColumnRange(
  image: GrayImage,
  top: number,
  bottom: number,
): [number, number] | null {
  let first = Infinity;
  let last = -1;
  for (let y = Math.max(0, top); y < Math.min(image.height, bottom); y++) {
    const offset = y * image.width;
    for (let x = 0; x < image.width; x++) {
      if (image.data[offset + x]! < INK_LEVEL) {
        if (x < first) first = x;
        if (x > last) last = x;
      }
    }
  }
  return last < 0 ? null : [first, last];
}

type Run = [start: number, end: number];

function blankRuns(rows: Uint32Array, from: number, to: number, blankLimit: number): Run[] {
  const runs: Run[] = [];
  let start = -1;
  for (let y = from; y <= to; y++) {
    const blank = rows[y]! <= blankLimit;
    if (blank && start < 0) start = y;
    if (!blank && start >= 0) {
      runs.push([start, y - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, to]);
  return runs;
}

function longestRun(runs: Run[], prefer: number): Run | null {
  let best: Run | null = null;
  for (const run of runs) {
    const length = run[1] - run[0];
    const bestLength = best ? best[1] - best[0] : -1;
    const closer =
      best && Math.abs((run[0] + run[1]) / 2 - prefer) < Math.abs((best[0] + best[1]) / 2 - prefer);
    if (length > bestLength || (length === bestLength && closer)) best = run;
  }
  return best;
}

/**
 * pitch — шаг строк всего документа; передаётся явно, когда страницы размечаются по одной
 * (на странице может быть слишком мало строк для надёжной оценки).
 */
export function layoutNumberedLines(
  lines: readonly NumberedLine[],
  rasters: ReadonlyMap<number, PageRaster>,
  pitch: number = estimatePitch(lines),
): LineBox[] {
  const byPage = new Map<number, NumberedLine[]>();
  for (const line of lines) byPage.set(line.page, [...(byPage.get(line.page) ?? []), line]);

  const boxes: LineBox[] = [];
  for (const [page, pageLines] of byPage) {
    const raster = rasters.get(page);
    if (!raster) throw new Error(`Нет изображения страницы ${page}`);
    boxes.push(...layoutPage(pageLines, raster, pitch));
  }
  return boxes;
}

function layoutPage(lines: NumberedLine[], raster: PageRaster, pitch: number): LineBox[] {
  const { image } = raster;
  const scale = image.height / raster.heightPt;
  const rows = inkPerRow(image);
  const blankLimit = Math.max(1, Math.round(image.width * 0.002));
  const pad = Math.round(2 * scale);
  const px = (pt: number) => Math.min(image.height - 1, Math.max(0, Math.round(pt * scale)));

  /** Нижняя граница строки перед большим промежутком: захватываем «хвосты» букв до длинной пустой полосы. */
  const expandDown = (line: NumberedLine) => {
    const from = px(line.yMax);
    const to = px(line.yMax + 0.4 * pitch);
    const run = longestRun(blankRuns(rows, from, to, blankLimit), from);
    return run ? Math.min(run[0] + pad, run[1] + 1) : to + 1;
  };

  const expandUp = (line: NumberedLine) => {
    const from = px(line.yMin - 0.4 * pitch);
    const to = px(line.yMin);
    const run = longestRun(blankRuns(rows, from, to, blankLimit), to);
    return run ? Math.max(run[1] + 1 - pad, run[0]) : from;
  };

  /** Граница между соседними строками — середина самой длинной пустой полосы между ними. */
  const splitBetween = (upper: NumberedLine, lower: NumberedLine) => {
    const from = px(upper.yMax - 0.25 * pitch);
    const to = px(lower.yMin + 0.25 * pitch);
    const middle = px((upper.yMax + lower.yMin) / 2);
    if (from >= to) return middle;
    const run = longestRun(blankRuns(rows, from, to, blankLimit), middle);
    if (run) return Math.floor((run[0] + run[1] + 1) / 2);
    let best = from;
    for (let y = from; y <= to; y++) {
      if (
        rows[y]! < rows[best]! ||
        (rows[y] === rows[best] && Math.abs(y - middle) < Math.abs(best - middle))
      )
        best = y;
    }
    return best;
  };

  const tops: number[] = [];
  const bottoms: number[] = [];
  const breaks: boolean[] = [];
  lines.forEach((line, i) => {
    const prev = lines[i - 1];
    if (!prev) {
      tops[i] = expandUp(line);
      breaks[i] = false;
      return;
    }
    const gap = line.yMin - prev.yMax;
    const bottom = gap > 0.6 * pitch ? expandDown(prev) : 0;
    const top = gap > 0.6 * pitch ? expandUp(line) : 0;
    if (gap <= 0.6 * pitch || top < bottom) {
      // Обычный промежуток (или окна расширения пересеклись) — делим посередине пустой полосы.
      const boundary = splitBetween(prev, line);
      bottoms[i - 1] = boundary;
      tops[i] = boundary;
    } else {
      bottoms[i - 1] = bottom;
      tops[i] = top;
    }
    breaks[i] = gap > 1.5 * pitch;
  });
  bottoms[lines.length - 1] = expandDown(lines.at(-1)!);

  let first = Infinity;
  let last = -1;
  lines.forEach((_, i) => {
    const columns = inkColumnRange(image, tops[i]!, bottoms[i]!);
    if (columns) {
      first = Math.min(first, columns[0]);
      last = Math.max(last, columns[1]);
    }
  });
  const sidePad = Math.round(6 * scale);
  const xLeft = last < 0 ? null : Math.max(0, first - sidePad) / scale;
  const xRight = last < 0 ? null : Math.min(image.width, last + 1 + sidePad) / scale;

  return lines.map((line, i) => ({
    lineNumber: line.lineNumber,
    printedNumber: line.printedNumber,
    page: line.page,
    yTop: tops[i]! / scale,
    yBottom: bottoms[i]! / scale,
    xLeft,
    xRight,
    sectionBreakBefore: breaks[i]!,
  }));
}
