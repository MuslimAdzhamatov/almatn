import type { PdfPageWords } from '../core/pdf/bbox.js';
import { pageChunks } from '../core/pdf/chunks.js';
import {
  dropRunningBands,
  imageLinesDefaults,
  imageLinesToBoxes,
  inkBands,
  refineBands,
  typicalHeight,
  typicalWidth,
  type InkBand,
  type PageBands,
} from '../core/pdf/imagelines.js';
import { inkPerRow, layoutNumberedLines, type LineBox } from '../core/pdf/layout.js';
import { pagesAsSlices, pagesAsUnits, type PageSize } from '../core/pdf/manual.js';
import {
  detectNumberedLines,
  estimatePitch,
  type NumberedLine,
  type NumberingAnomaly,
} from '../core/pdf/numbers.js';
import { dropFootnotes, paragraphsToBoxes } from '../core/pdf/paragraphs.js';
import { PdfToolError } from '../core/pdf/poppler.js';
import { attachHeadings, detectTextLines, type TextLine } from '../core/pdf/textlines.js';
import { limits } from '../config/limits.js';
import type { ParseReport, ParseRequest, ParseStrategy, PdfTools } from './ports.js';

// Разбор на единицы заучивания (CLAUDE.md, раздел 4.1). Порядок при `strategy = auto`:
// номера строк → строки текстового слоя → абзацы по изображению → строки по изображению →
// постранично. Пользователь может задать стратегию и диапазон страниц сам («Разобрать по-другому»).

export const AUTO: ParseRequest = { strategy: 'auto' };

export interface ParsedPdf {
  strategy: ParseStrategy;
  boxes: LineBox[];
  report: ParseReport;
}

/** Полоса на странице: строка текста или заголовок раздела перед ней. */
interface Unit {
  line: NumberedLine;
  heading: boolean;
}

interface ParsePlan {
  strategy: ParseStrategy;
  units: Unit[];
  firstPage: number;
  lastPage: number;
  anomalies: NumberingAnomaly[];
}

interface Scanned {
  page: number;
  width: number;
  height: number;
  widthPt: number;
  heightPt: number;
  rows: Uint32Array;
  bands: InkBand[];
}

export async function parsePdf(
  file: string,
  workDir: string,
  tools: PdfTools,
  request: ParseRequest = AUTO,
  /** Удаление отрендеренной для анализа страницы — после обработки её части. */
  discard: (path: string) => Promise<void> = async () => undefined,
): Promise<ParsedPdf> {
  const all = await tools.words(file);
  if (all.length === 0) throw new PdfToolError('В PDF нет страниц', 'damaged');
  const pages = selectPages(all, request);
  if (pages.length === 0) throw new PdfToolError('В выбранном диапазоне нет страниц', 'damaged');

  const sizes = pages.map((page) => ({
    page: page.page,
    widthPt: page.width,
    heightPt: page.height,
  }));
  if (request.strategy === 'manual_page' || request.strategy === 'manual_split') {
    return manualParse(sizes, request);
  }

  const plan = planUnits(pages, request.strategy);
  if (!plan) {
    // Ни номеров, ни пригодного текстового слоя — скан: строки ищутся по изображению страниц.
    if (request.strategy !== 'text_lines' && request.strategy !== 'numbers') {
      const byImage = await parseByImage(file, workDir, tools, pages, discard, request);
      if (byImage) return byImage;
    }
    return manualParse(sizes, request, request.strategy === 'auto');
  }

  // Страницы анализируются по одной, чтобы не держать в памяти изображения всего документа,
  // а рендерятся частями — чтобы большие книги не упирались в таймаут pdftoppm и не занимали диск.
  const pitch = estimatePitch(plan.units.map((unit) => unit.line));
  const byPage = new Map<number, Unit[]>();
  for (const unit of plan.units)
    byPage.set(unit.line.page, [...(byPage.get(unit.line.page) ?? []), unit]);

  const boxes: LineBox[] = [];
  const headings: boolean[] = [];
  const chunks = pageChunks(plan.firstPage, plan.lastPage, limits.pdf.renderChunkPages);
  for (const [firstPage, lastPage] of chunks) {
    const chunkPages = [...byPage.keys()].filter((page) => page >= firstPage && page <= lastPage);
    if (chunkPages.length === 0) continue;
    const rendered = await tools.render(file, {
      outDir: workDir,
      dpi: limits.pdf.analysisDpi,
      gray: true,
      firstPage,
      lastPage,
    });
    try {
      for (const page of chunkPages) {
        const path = rendered.get(page);
        const size = all[page - 1];
        if (!path || !size) throw new PdfToolError(`Страница ${page} не отрендерилась`, 'damaged');
        const raster = {
          page,
          widthPt: size.width,
          heightPt: size.height,
          image: await tools.loadGray(path),
        };
        const units = byPage.get(page)!;
        boxes.push(
          ...layoutNumberedLines(
            units.map((unit) => unit.line),
            new Map([[page, raster]]),
            pitch,
          ),
        );
        headings.push(...units.map((unit) => unit.heading));
      }
    } finally {
      for (const path of rendered.values()) await discard(path);
    }
  }

  return {
    strategy: plan.strategy,
    // Заголовки размечались вместе со строками, чтобы границы уточнились по пикселям,
    // и только теперь становятся фрагментами своих единиц.
    boxes: headings.some(Boolean) ? attachHeadings(boxes, headings) : boxes,
    report: { firstPage: plan.firstPage, lastPage: plan.lastPage, anomalies: plan.anomalies },
  };
}

/**
 * Разбор текста из присланных картинок: страница — сам файл, рендерить нечего.
 * Координаты хранятся в пикселях страницы (масштаб 1), поэтому вырезка работает так же, как у PDF.
 */
export async function parseImagePages(
  paths: readonly string[],
  tools: Pick<PdfTools, 'loadGray'>,
  request: ParseRequest = AUTO,
): Promise<ParsedPdf | null> {
  const scanned: Scanned[] = [];
  const sizes: PageSize[] = [];
  for (const [index, path] of paths.entries()) {
    const page = index + 1;
    if (!inRange(page, request)) continue;
    const image = await tools.loadGray(path);
    const rows = inkPerRow(image);
    scanned.push({
      page,
      width: image.width,
      height: image.height,
      widthPt: image.width,
      heightPt: image.height,
      rows,
      bands: inkBands(image, rows),
    });
    sizes.push({ page, widthPt: image.width, heightPt: image.height });
  }
  if (scanned.length === 0) return null;

  if (request.strategy === 'manual_page' || request.strategy === 'manual_split') {
    return manualParse(sizes, request);
  }
  const parsed = buildImageParse(scanned, request);
  if (parsed) return parsed;
  return request.strategy === 'auto' ? manualParse(sizes, request, true) : null;
}

/** Страницы выбранного диапазона; без диапазона — весь файл. */
function selectPages(pages: readonly PdfPageWords[], request: ParseRequest): PdfPageWords[] {
  return pages.filter((page) => inRange(page.page, request));
}

const inRange = (page: number, request: ParseRequest) =>
  page >= (request.pageFrom ?? 1) && page <= (request.pageTo ?? Number.MAX_SAFE_INTEGER);

/** Ручной режим: страница целиком или N равных полос со страницы. */
function manualParse(
  sizes: readonly PageSize[],
  request: ParseRequest,
  fallback = false,
): ParsedPdf {
  const split = request.strategy === 'manual_split';
  const boxes = split ? pagesAsSlices(sizes, request.linesPerPage ?? 1) : pagesAsUnits(sizes);
  return {
    strategy: split ? 'manual_split' : 'manual_page',
    boxes,
    report: {
      firstPage: sizes[0]!.page,
      lastPage: sizes.at(-1)!.page,
      anomalies: [],
      ...(fallback && { fallbackReason: 'no_text_layer' as const }),
    },
  };
}

/**
 * Разбор по изображению: страницы рендерятся частями, от каждой остаются только профиль
 * тёмных пикселей и полосы (несколько килобайт на страницу), сами картинки сразу удаляются.
 */
async function parseByImage(
  file: string,
  workDir: string,
  tools: PdfTools,
  pages: readonly PdfPageWords[],
  discard: (path: string) => Promise<void>,
  request: ParseRequest,
): Promise<ParsedPdf | null> {
  const wanted = new Set(pages.map((page) => page.page));
  const firstWanted = pages[0]!.page;
  const lastWanted = pages.at(-1)!.page;

  const scanned: Scanned[] = [];
  for (const [firstPage, lastPage] of pageChunks(
    firstWanted,
    lastWanted,
    limits.pdf.renderChunkPages,
  )) {
    const rendered = await tools.render(file, {
      outDir: workDir,
      dpi: limits.pdf.analysisDpi,
      gray: true,
      firstPage,
      lastPage,
    });
    try {
      for (let page = firstPage; page <= lastPage; page++) {
        const path = rendered.get(page);
        const size = pages.find((item) => item.page === page);
        if (!path || !size || !wanted.has(page)) continue;
        const image = await tools.loadGray(path);
        const rows = inkPerRow(image);
        scanned.push({
          page,
          width: image.width,
          height: image.height,
          widthPt: size.width,
          heightPt: size.height,
          rows,
          bands: inkBands(image, rows),
        });
      }
    } finally {
      for (const path of rendered.values()) await discard(path);
    }
  }

  return buildImageParse(scanned, request);
}

/**
 * Общая часть разбора по изображению: обычная строка, классификация полос, единицы.
 * При `auto` сначала пробуем абзацы (проза: хадисы), потом строки (стихи и сканы поэзии).
 */
function buildImageParse(scanned: readonly Scanned[], request: ParseRequest): ParsedPdf | null {
  const { strategy } = request;
  const bands = scanned.flatMap((page) => page.bands);
  const height = typicalHeight(bands, imageLinesDefaults.minHeightShare);
  if (height <= 0) return null;
  const width = typicalWidth(bands, height);

  const classified: PageBands[] = scanned.map((page) => ({
    page: page.page,
    width: page.width,
    height: page.height,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    bands: refineBands(page.bands, page.rows, { height, width, imageWidth: page.width }),
  }));
  const cleaned = dropRunningBands(classified, height);

  if (strategy === 'auto' || strategy === 'paragraphs') {
    const paragraphs = paragraphsToBoxes(dropFootnotes(cleaned), {
      ...(request.maxLines !== undefined && { maxLinesPerUnit: request.maxLines }),
    });
    if (paragraphs) return imageResult('paragraphs', paragraphs);
    if (strategy === 'paragraphs') return null;
  }

  const boxes = imageLinesToBoxes(cleaned);
  if (boxes.length < imageLinesDefaults.minLines) return null;
  return imageResult('image_lines', boxes);
}

function imageResult(strategy: ParseStrategy, boxes: LineBox[]): ParsedPdf {
  return {
    strategy,
    boxes,
    report: { firstPage: boxes[0]!.page, lastPage: boxes.at(-1)!.page, anomalies: [] },
  };
}

/** Какой стратегией разбирать текстовый слой и какие полосы размечать. */
function planUnits(
  pages: readonly PdfPageWords[],
  strategy: ParseRequest['strategy'],
): ParsePlan | null {
  if (strategy === 'auto' || strategy === 'numbers') {
    const numbered = detectNumberedLines(pages);
    if (numbered) {
      return {
        strategy: 'numbers',
        units: numbered.lines.map((line) => ({ line, heading: false })),
        firstPage: numbered.firstPage,
        lastPage: numbered.lastPage,
        anomalies: numbered.anomalies,
      };
    }
    if (strategy === 'numbers') return null;
  }
  if (strategy !== 'auto' && strategy !== 'text_lines') return null;

  const text = detectTextLines(pages);
  if (!text) return null;

  // Строки и заголовки идут вперемежку в порядке чтения; номера единиц проставит attachHeadings.
  const units: Unit[] = [
    ...text.lines.map((line) => ({ line: toNumbered(line), heading: false })),
    ...text.headings.map((heading) => ({ line: toNumbered(heading.line), heading: true })),
  ].sort((a, b) => a.line.page - b.line.page || a.line.yMin - b.line.yMin);

  return {
    strategy: 'text_lines',
    units,
    firstPage: text.firstPage,
    lastPage: text.lastPage,
    anomalies: [],
  };
}

const toNumbered = (line: TextLine): NumberedLine => ({
  lineNumber: 0,
  printedNumber: null,
  page: line.page,
  yMin: line.yMin,
  yMax: line.yMax,
});
