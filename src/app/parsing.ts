import { limits } from '../config/limits.js';
import { pageChunks } from '../core/pdf/chunks.js';
import type { PdfPageWords } from '../core/pdf/bbox.js';
import { layoutNumberedLines, type LineBox } from '../core/pdf/layout.js';
import { pagesAsUnits } from '../core/pdf/manual.js';
import { detectNumberedLines, estimatePitch, type NumberedLine } from '../core/pdf/numbers.js';
import { PdfToolError } from '../core/pdf/poppler.js';
import type { NumberingAnomaly } from '../core/pdf/numbers.js';
import { attachHeadings, detectTextLines, type TextLine } from '../core/pdf/textlines.js';
import type { ParseReport, ParseStrategy, PdfTools } from './ports.js';

// Разбор PDF на единицы заучивания (CLAUDE.md, раздел 4.1): по напечатанным номерам,
// иначе по строкам текстового слоя, иначе постранично. Разбор сканов по изображению — шаг 3b.3.

/** auto — по номерам или по строкам текста; manual_page — страница целиком. */
export type ParseMode = 'auto' | 'manual_page';

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

export async function parsePdf(
  file: string,
  workDir: string,
  tools: PdfTools,
  mode: ParseMode = 'auto',
  /** Удаление отрендеренной для анализа страницы — после обработки её части. */
  discard: (path: string) => Promise<void> = async () => undefined,
): Promise<ParsedPdf> {
  const pages = await tools.words(file);
  if (pages.length === 0) throw new PdfToolError('В PDF нет страниц', 'damaged');

  const plan = mode === 'auto' ? planUnits(pages) : null;
  if (!plan) {
    const sizes = pages.map((p) => ({ page: p.page, widthPt: p.width, heightPt: p.height }));
    return {
      strategy: 'manual_page',
      boxes: pagesAsUnits(sizes),
      report: {
        firstPage: 1,
        lastPage: pages.length,
        anomalies: [],
        ...(mode === 'auto' && { fallbackReason: 'no_text_layer' as const }),
      },
    };
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
        const size = pages[page - 1];
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

/** Какой стратегией разбирать и какие полосы размечать. */
function planUnits(pages: readonly PdfPageWords[]): ParsePlan | null {
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
