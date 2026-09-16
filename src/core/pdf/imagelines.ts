import {
  inkColumnRange,
  inkPerRow,
  type Fragment,
  type GrayImage,
  type LineBox,
} from './layout.js';
import { attachHeadings } from './textlines.js';

// Стратегия «по изображению» (CLAUDE.md, раздел 4.1, стратегия 3): сканы и PDF со сломанным
// текстовым слоем. Строки ищутся по горизонтальному профилю тёмных пикселей: полосы текста
// между пустыми промежутками. Всё в пикселях отрендеренной страницы; в пункты переводится в конце.

/** Полоса тёмных пикселей между пустыми промежутками. */
export interface InkBand {
  top: number;
  bottom: number;
  /** Самая «чернильная» строка пикселей полосы — у сплошной линии рамки она почти во всю ширину. */
  maxInk: number;
  xMin: number;
  xMax: number;
}

/** Строка текста, заголовок раздела или сплошная линия (рамка, черта над сносками). */
export type BandKind = 'text' | 'heading' | 'rule';

export interface ClassifiedBand extends InkBand {
  kind: BandKind;
}

export interface PageBands {
  page: number;
  /** Размер отрендеренной страницы в пикселях. */
  width: number;
  height: number;
  /** Размер страницы в пунктах PDF — в них пересчитываются границы вырезки. */
  widthPt: number;
  heightPt: number;
  bands: ClassifiedBand[];
}

export interface ImageLinesOptions {
  /** Полоса ниже этой доли обычной высоты — огласовка или шум: присоединяется к соседней строке. */
  minHeightShare: number;
  /** Полоса выше этой доли обычной высоты — несколько слипшихся строк: делится по профилю. */
  maxHeightShare: number;
  /**
   * Сплошная линия (рамка, черта над сносками): либо самая тёмная строка пикселей занимает
   * такую долю ширины страницы, либо полоса тонкая и заметно темнее строки текста.
   * У настоящей строки текста максимум чернил около трети ширины — буквы не заполняют её подряд.
   */
  ruleInkShare: number;
  thinRuleInkShare: number;
  /** Доля обычной высоты строки, ниже которой полоса считается тонкой. */
  thinHeightShare: number;
  /** Полоса уже этой доли обычной ширины строки — заголовок раздела. */
  headingWidthShare: number;
  /** Полоса у верхнего и нижнего края страницы, где ищутся колонтитулы (доля высоты). */
  marginBand: number;
  /** На какой доле страниц должна повторяться полоса на той же высоте, чтобы счесть её колонтитулом. */
  repeatShare: number;
  /** Разброс высоты колонтитула между страницами (доля обычной высоты строки). */
  runningTolerance: number;
  /** Страница считается страницей текста, если строк на ней не меньше этой доли от обычного. */
  pageFullness: number;
  /** Меньше строк во всём документе — результат неправдоподобен. */
  minLines: number;
}

const DEFAULTS: ImageLinesOptions = {
  minHeightShare: 0.4,
  maxHeightShare: 1.6,
  ruleInkShare: 0.6,
  thinRuleInkShare: 0.35,
  thinHeightShare: 0.5,
  headingWidthShare: 0.65,
  marginBand: 0.12,
  repeatShare: 0.5,
  runningTolerance: 0.2,
  pageFullness: 0.4,
  minLines: 10,
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const heightOf = (band: InkBand) => band.bottom - band.top + 1;

/** Полосы тёмных пикселей страницы сверху вниз. */
export function inkBands(
  image: GrayImage,
  rows: Uint32Array = inkPerRow(image),
  blankLimit = Math.max(1, Math.round(image.width * 0.002)),
): InkBand[] {
  const bands: InkBand[] = [];
  let top = -1;
  let maxInk = 0;
  for (let y = 0; y <= image.height; y++) {
    const ink = y < image.height ? rows[y]! : 0;
    if (ink > blankLimit) {
      if (top < 0) {
        top = y;
        maxInk = 0;
      }
      maxInk = Math.max(maxInk, ink);
    } else if (top >= 0) {
      const columns = inkColumnRange(image, top, y);
      bands.push({
        top,
        bottom: y - 1,
        maxInk,
        xMin: columns?.[0] ?? 0,
        xMax: columns?.[1] ?? image.width - 1,
      });
      top = -1;
    }
  }
  return bands;
}

/** Обычная высота строки по всему документу: медиана, пересчитанная без мелкого шума. */
export function typicalHeight(bands: readonly InkBand[], minHeightShare: number): number {
  if (bands.length === 0) return 0;
  const rough = median(bands.map(heightOf));
  const kept = bands.map(heightOf).filter((height) => height >= rough * minHeightShare);
  return kept.length > 0 ? median(kept) : rough;
}

/**
 * Полосы страницы → строки: сплошные линии помечаются, огласовки и шум присоединяются к
 * ближайшей строке, слипшиеся строки делятся по самому светлому месту, узкие полосы — заголовки.
 */
export function refineBands(
  bands: readonly InkBand[],
  rows: Uint32Array,
  typical: { height: number; width: number; imageWidth: number },
  options: Partial<ImageLinesOptions> = {},
): ClassifiedBand[] {
  const opts = { ...DEFAULTS, ...options };
  if (bands.length === 0) return [];

  const result: ClassifiedBand[] = [];
  const pending: InkBand[] = [];

  for (const band of bands) {
    const height = heightOf(band);
    const thin = height <= typical.height * opts.thinHeightShare;
    if (
      band.maxInk >= typical.imageWidth * opts.ruleInkShare ||
      (thin && band.maxInk >= typical.imageWidth * opts.thinRuleInkShare)
    ) {
      // Сплошная горизонтальная линия: рамка колонтитула или черта над сносками.
      result.push({ ...band, kind: 'rule' });
      continue;
    }
    if (height < typical.height * opts.minHeightShare) {
      pending.push(band);
      continue;
    }
    for (const part of splitBand(band, rows, typical.height, opts.maxHeightShare)) {
      result.push({
        ...part,
        kind: part.xMax - part.xMin < typical.width * opts.headingWidthShare ? 'heading' : 'text',
      });
    }
  }

  // Мелкие полосы (харакаты, точки) присоединяются к ближайшей строке, если она рядом.
  for (const small of pending) {
    const nearest = closestLine(result, small, typical.height);
    if (!nearest) continue;
    nearest.top = Math.min(nearest.top, small.top);
    nearest.bottom = Math.max(nearest.bottom, small.bottom);
    nearest.xMin = Math.min(nearest.xMin, small.xMin);
    nearest.xMax = Math.max(nearest.xMax, small.xMax);
  }

  return result.sort((a, b) => a.top - b.top);
}

function closestLine(
  bands: ClassifiedBand[],
  small: InkBand,
  typicalHeight: number,
): ClassifiedBand | null {
  let best: ClassifiedBand | null = null;
  let bestDistance = typicalHeight * 0.6;
  for (const band of bands) {
    if (band.kind === 'rule') continue;
    const distance =
      small.top > band.bottom ? small.top - band.bottom : Math.max(0, band.top - small.bottom);
    if (distance <= bestDistance) {
      best = band;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Слипшиеся строки: полоса делится на равные части по самому светлому месту рядом с границей.
 * Границы по горизонтали наследуются от всей полосы — подстроки одного абзаца одинаковой ширины.
 */
function splitBand(
  band: InkBand,
  rows: Uint32Array,
  typicalHeight: number,
  maxHeightShare: number,
): InkBand[] {
  const height = heightOf(band);
  if (typicalHeight <= 0 || height <= typicalHeight * maxHeightShare) return [band];

  const parts = Math.max(2, Math.round(height / typicalHeight));
  const window = Math.round(typicalHeight * 0.3);
  const cuts: number[] = [];
  for (let i = 1; i < parts; i++) {
    const target = band.top + Math.round((height * i) / parts);
    let best = target;
    for (
      let y = Math.max(band.top + 1, target - window);
      y <= Math.min(band.bottom - 1, target + window);
      y++
    ) {
      if (rows[y]! < rows[best]!) best = y;
    }
    cuts.push(best);
  }

  const edges = [band.top - 1, ...cuts, band.bottom];
  const result: InkBand[] = [];
  for (let i = 1; i < edges.length; i++) {
    const top = edges[i - 1]! + 1;
    const bottom = edges[i]!;
    if (bottom < top) continue;
    let maxInk = 0;
    for (let y = top; y <= bottom; y++) maxInk = Math.max(maxInk, rows[y]!);
    result.push({ top, bottom, maxInk, xMin: band.xMin, xMax: band.xMax });
  }
  return result;
}

/** Обычная ширина строки: медиана ширин полос обычной высоты. */
export function typicalWidth(bands: readonly InkBand[], height: number): number {
  const normal = bands.filter((band) => {
    const h = heightOf(band);
    return h >= height * 0.6 && h <= height * 1.6;
  });
  const source = normal.length > 0 ? normal : bands;
  return source.length > 0 ? median(source.map((band) => band.xMax - band.xMin)) : 0;
}

/**
 * Колонтитулы: узкая полоса у края страницы, повторяющаяся примерно на той же высоте
 * на большинстве страниц. Сплошные линии рамки убираются всегда.
 */
export function dropRunningBands(
  pages: readonly PageBands[],
  typicalHeight: number,
  options: Partial<ImageLinesOptions> = {},
): PageBands[] {
  const opts = { ...DEFAULTS, ...options };
  const tolerance = Math.max(2, typicalHeight * opts.runningTolerance);
  const needed = Math.max(3, Math.ceil(pages.length * opts.repeatShare));

  const candidates: { page: number; band: ClassifiedBand; side: 'top' | 'bottom' }[] = [];
  for (const page of pages) {
    const band = page.height * opts.marginBand;
    for (const item of page.bands) {
      if (item.kind === 'rule') continue;
      const atTop = item.bottom <= band;
      const atBottom = item.top >= page.height - band;
      if (!atTop && !atBottom) continue;
      candidates.push({ page: page.page, band: item, side: atTop ? 'top' : 'bottom' });
    }
  }

  const running = new Set<ClassifiedBand>();
  for (const side of ['top', 'bottom'] as const) {
    const sorted = candidates
      .filter((item) => item.side === side)
      .sort((a, b) => a.band.top - b.band.top);
    let cluster: typeof sorted = [];
    const flush = () => {
      if (new Set(cluster.map((item) => item.page)).size >= needed) {
        for (const item of cluster) running.add(item.band);
      }
      cluster = [];
    };
    for (const item of sorted) {
      const previous = cluster.at(-1);
      if (previous && item.band.top - previous.band.top > tolerance) flush();
      cluster.push(item);
    }
    flush();
  }

  return pages.map((page) => ({
    ...page,
    bands: page.bands.filter((band) => band.kind !== 'rule' && !running.has(band)),
  }));
}

/**
 * Страницы с размеченными полосами → единицы заучивания. Обложка и пустые страницы
 * отбрасываются как страницы с малым числом строк, заголовки становятся фрагментами `heading`.
 */
export function imageLinesToBoxes(
  pages: readonly PageBands[],
  options: Partial<ImageLinesOptions> = {},
): LineBox[] {
  const opts = { ...DEFAULTS, ...options };
  const textPages = mainPages(pages, opts.pageFullness);

  const boxes: LineBox[] = [];
  const headings: boolean[] = [];
  for (const page of textPages) {
    const scaleY = page.heightPt / page.height;
    const scaleX = page.widthPt / page.width;
    const pad = Math.round(page.height * 0.002);
    page.bands.forEach((band, index) => {
      const previous = page.bands[index - 1];
      const next = page.bands[index + 1];
      const top = previous
        ? Math.max((previous.bottom + band.top) / 2, band.top - pad)
        : band.top - pad;
      const bottom = next
        ? Math.min((band.bottom + next.top) / 2, band.bottom + pad)
        : band.bottom + pad;
      boxes.push({
        lineNumber: boxes.length + 1,
        printedNumber: null,
        page: page.page,
        sectionBreakBefore: false,
        fragments: [
          {
            kind: 'text',
            page: page.page,
            yTop: Math.max(0, top) * scaleY,
            yBottom: Math.min(page.height, bottom) * scaleY,
            xLeft: band.xMin * scaleX,
            xRight: (band.xMax + 1) * scaleX,
          } satisfies Fragment,
        ],
      });
      headings.push(band.kind === 'heading');
    });
  }

  return headings.some(Boolean) ? attachHeadings(boxes, headings) : boxes;
}

function mainPages(pages: readonly PageBands[], fullness: number): PageBands[] {
  // Считаются строки текста: на обложке рамка и узор дают десяток полос, но текста там нет.
  const textCount = (page: PageBands) => page.bands.filter((band) => band.kind === 'text').length;
  const counts = pages.map(textCount).filter((count) => count > 0);
  if (counts.length === 0) return [];
  const needed = Math.max(1, median(counts) * fullness);

  let bestFrom = -1;
  let bestTo = -1;
  let bestLength = 0;
  let from = -1;
  for (let i = 0; i < pages.length; i++) {
    if (textCount(pages[i]!) >= needed) {
      if (from < 0) from = i;
      // Длина считается явно: у отрезка из одной страницы она равна 1, а не 0.
      if (i - from + 1 > bestLength) {
        bestLength = i - from + 1;
        bestFrom = from;
        bestTo = i;
      }
    } else {
      from = -1;
    }
  }
  if (bestFrom < 0) return [];

  // Первая и последняя страницы книги обычно неполные (концовка, колофон) — их нельзя терять.
  // Расширяемся, пока у соседней страницы есть хоть одна строка текста: обложку отделяет пустая
  // страница, а если её нет — лишние страницы уберёт выбор диапазона в сводке.
  while (bestFrom > 0 && textCount(pages[bestFrom - 1]!) > 0) bestFrom--;
  while (bestTo < pages.length - 1 && textCount(pages[bestTo + 1]!) > 0) bestTo++;
  return pages.slice(bestFrom, bestTo + 1);
}

export { DEFAULTS as imageLinesDefaults };
