import type { ClassifiedBand, PageBands } from './imagelines.js';
import { textFragment, type Fragment, type LineBox } from './layout.js';
import { attachHeadings } from './textlines.js';

// Стратегия «абзацы» (CLAUDE.md, раздел 4.1, стратегия 4): проза, где единица заучивания —
// абзац целиком (хадис). Номера абзацев из PDF брать не получается: в сборниках хадисов
// текстовый слой обычно сломан, а на изображении номер не отделяется от текста — пробел после
// него такой же, как между словами. Поэтому абзацы нумеруются по порядку.
//
// Признак конца абзаца — короткая последняя строка: в наборе строки выключены по обоим краям,
// и только последняя строка абзаца не дотягивает до края.

export interface ParagraphOptions {
  /** Строка уже этой доли обычной ширины — последняя в абзаце. */
  shortLineShare: number;
  /** Сноски набраны мельче: хвост страницы со строками ниже этой доли обычной высоты. */
  footnoteHeightShare: number;
  /** Меньше строк на абзац — это не проза (например, стихи), стратегия не подходит. */
  minLinesPerParagraph: number;
  /** Меньше абзацев во всём тексте — результат неправдоподобен. */
  minParagraphs: number;
  /** Отступ с обеих сторон (доля обычной ширины строки), по которому узнаётся заголовок. */
  headingIndentShare: number;
  /** Абзац длиннее этого числа строк делится на части (0 — не делить). */
  maxLinesPerUnit: number;
}

const DEFAULTS: ParagraphOptions = {
  shortLineShare: 0.85,
  footnoteHeightShare: 0.75,
  minLinesPerParagraph: 1.6,
  minParagraphs: 3,
  headingIndentShare: 0.05,
  maxLinesPerUnit: 0,
};

/**
 * Ровные части не длиннее max: 12 строк по 5 — это 4+4+4, а не 5+5+2.
 * Так у длинного абзаца не остаётся огрызка в одну строку.
 */
export function splitEvenly<T>(items: readonly T[], max: number): T[][] {
  if (max < 1 || items.length <= max) return [[...items]];
  const parts = Math.ceil(items.length / max);
  const base = Math.floor(items.length / parts);
  const longer = items.length % parts; // первым частям достаётся на строку больше
  const chunks: T[][] = [];
  let start = 0;
  for (let i = 0; i < parts; i++) {
    const size = base + (i < longer ? 1 : 0);
    chunks.push(items.slice(start, start + size));
    start += size;
  }
  return chunks;
}

function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/**
 * Квантиль. Полная ширина строки и границы набора считаются по высокому квантилю, а не по
 * медиане: в прозе с короткими абзацами (два-три хадиса на страницу) половина строк короткие,
 * и медиана уехала бы на них — тогда каждая строка стала бы отдельным абзацем.
 */
function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * share)));
  return sorted[index]!;
}

const heightOf = (band: ClassifiedBand) => band.bottom - band.top + 1;
const widthOf = (band: ClassifiedBand) => band.xMax - band.xMin;

/**
 * Сноски под чертой: хвост страницы, набранный мельче основного текста.
 * Отсекается именно хвост — сноски всегда внизу, а мелкая строка в середине текста
 * (обрывок, номер аята) абзацы не ломает.
 */
export function dropFootnotes(
  pages: readonly PageBands[],
  options: Partial<ParagraphOptions> = {},
): PageBands[] {
  const opts = { ...DEFAULTS, ...options };
  const all = pages.flatMap((page) => page.bands.filter((band) => band.kind !== 'rule'));
  if (all.length === 0) return [...pages];
  const mainHeight = median(all.map(heightOf));

  return pages.map((page) => {
    const bands = [...page.bands].sort((a, b) => a.top - b.top);
    let cut = bands.length;
    for (let i = bands.length - 1; i >= 0; i--) {
      const band = bands[i]!;
      if (band.kind === 'rule') continue;
      if (heightOf(band) < mainHeight * opts.footnoteHeightShare) cut = i;
      else break;
    }
    return { ...page, bands: bands.slice(0, cut) };
  });
}

/**
 * Строки → абзацы. Абзац продолжается, пока строка не окажется короткой, и может переходить
 * на следующую страницу; тогда у него по фрагменту на страницу. Заголовок раздела закрывает
 * текущий абзац и попадает в картинку следующего.
 * null — строки не похожи на прозу (в стихах короткой оказывается почти каждая строка).
 */
export function paragraphsToBoxes(
  pages: readonly PageBands[],
  options: Partial<ParagraphOptions> = {},
): LineBox[] | null {
  const opts = { ...DEFAULTS, ...options };

  const lines: Line[] = [];
  for (const page of pages) {
    for (const band of [...page.bands].sort((a, b) => a.top - b.top)) {
      if (band.kind !== 'rule') lines.push({ band, page });
    }
  }
  const textLines = lines.filter((line) => line.band.kind === 'text');
  if (textLines.length === 0) return null;

  const fullWidth = percentile(
    textLines.map((line) => widthOf(line.band)),
    0.8,
  );
  const isShort = (line: Line) => widthOf(line.band) < fullWidth * opts.shortLineShare;

  // Границы набора: последняя строка абзаца прижата к одному краю, а заголовок стоит
  // с отступами с обеих сторон. Без этого короткая строка абзаца принимается за заголовок —
  // разметка полос по ширине (imagelines) для прозы такой разницы не видит.
  const left = percentile(
    lines.map((line) => line.band.xMin),
    0.2,
  );
  const right = percentile(
    lines.map((line) => line.band.xMax),
    0.8,
  );
  const indent = fullWidth * opts.headingIndentShare;
  const isHeading = (line: Line) =>
    isShort(line) && line.band.xMin - left > indent && right - line.band.xMax > indent;

  // Единицы в порядке чтения: абзацы и заголовки вперемежку, заголовки отметятся флагом.
  const units: { lines: Line[]; heading: boolean }[] = [];
  let current: Line[] = [];
  const flush = () => {
    if (current.length > 0) units.push({ lines: current, heading: false });
    current = [];
  };

  for (const line of lines) {
    if (isHeading(line)) {
      flush();
      units.push({ lines: [line], heading: true });
      continue;
    }
    current.push(line);
    if (isShort(line)) flush();
  }
  flush();

  const paragraphs = units.filter((unit) => !unit.heading);
  if (paragraphs.length < opts.minParagraphs) return null;
  const linesPerParagraph =
    paragraphs.reduce((total, unit) => total + unit.lines.length, 0) / paragraphs.length;
  if (linesPerParagraph < opts.minLinesPerParagraph) return null;

  // Делить длинные абзацы — уже после проверок правдоподобия: они считаются по целым абзацам.
  const split =
    opts.maxLinesPerUnit > 0
      ? units.flatMap((unit) =>
          unit.heading
            ? [unit]
            : splitEvenly(unit.lines, opts.maxLinesPerUnit).map((part) => ({
                lines: part,
                heading: false,
              })),
        )
      : units;

  const boxes = split.map((unit, index) => toBox(unit.lines, index + 1));
  return attachHeadings(
    boxes,
    split.map((unit) => unit.heading),
  );
}

/** Строки одной единицы → фрагменты: по одному на каждую страницу, в пунктах PDF. */
function toBox(lines: readonly Line[], lineNumber: number): LineBox {
  const byPage = new Map<number, Line[]>();
  for (const line of lines) {
    byPage.set(line.page.page, [...(byPage.get(line.page.page) ?? []), line]);
  }

  const fragments: Fragment[] = [];
  for (const [pageNumber, pageLines] of byPage) {
    const page = pageLines[0]!.page;
    const scaleY = page.heightPt / page.height;
    const scaleX = page.widthPt / page.width;
    const pad = Math.max(1, Math.round(page.height * 0.002));
    const top = Math.max(0, Math.min(...pageLines.map((line) => line.band.top)) - pad);
    const bottom = Math.min(
      page.height,
      Math.max(...pageLines.map((line) => line.band.bottom)) + pad,
    );
    fragments.push(
      textFragment(
        pageNumber,
        top * scaleY,
        bottom * scaleY,
        Math.min(...pageLines.map((line) => line.band.xMin)) * scaleX,
        (Math.max(...pageLines.map((line) => line.band.xMax)) + 1) * scaleX,
      ),
    );
  }

  return {
    lineNumber,
    printedNumber: null,
    page: fragments[0]!.page,
    sectionBreakBefore: false,
    fragments,
  };
}

interface Line {
  band: ClassifiedBand;
  page: PageBands;
}

export { DEFAULTS as paragraphDefaults };
