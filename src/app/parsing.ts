import { limits } from '../config/limits.js';
import { layoutNumberedLines, type LineBox } from '../core/pdf/layout.js';
import { pagesAsUnits } from '../core/pdf/manual.js';
import { detectNumberedLines, estimatePitch, type NumberedLine } from '../core/pdf/numbers.js';
import { PdfToolError } from '../core/pdf/poppler.js';
import type { ParseReport, ParseStrategy, PdfTools } from './ports.js';

// Разбор PDF на строки (CLAUDE.md, раздел 4.1): по напечатанным номерам, иначе — постранично.
// Разбор по строкам текстового слоя и по изображению (сканы) — этап 3b.

/** auto — по номерам, если они найдены; manual_page — страница целиком. */
export type ParseMode = 'auto' | 'manual_page';

export interface ParsedPdf {
  strategy: ParseStrategy;
  boxes: LineBox[];
  report: ParseReport;
}

export async function parsePdf(
  file: string,
  workDir: string,
  tools: PdfTools,
  mode: ParseMode = 'auto',
): Promise<ParsedPdf> {
  const pages = await tools.words(file);
  if (pages.length === 0) throw new PdfToolError('В PDF нет страниц', 'damaged');

  const numbered = mode === 'auto' ? detectNumberedLines(pages) : null;
  if (!numbered) {
    const sizes = pages.map((p) => ({ page: p.page, widthPt: p.width, heightPt: p.height }));
    return {
      strategy: 'manual_page',
      boxes: pagesAsUnits(sizes),
      report: {
        firstPage: 1,
        lastPage: pages.length,
        anomalies: [],
        ...(mode === 'auto' && { fallbackReason: 'no_numbers' as const }),
      },
    };
  }

  const rendered = await tools.render(file, {
    outDir: workDir,
    dpi: limits.pdf.analysisDpi,
    gray: true,
    firstPage: numbered.firstPage,
    lastPage: numbered.lastPage,
  });

  // Страницы анализируются по одной, чтобы не держать в памяти изображения всего документа.
  const pitch = estimatePitch(numbered.lines);
  const byPage = new Map<number, NumberedLine[]>();
  for (const line of numbered.lines)
    byPage.set(line.page, [...(byPage.get(line.page) ?? []), line]);

  const boxes: LineBox[] = [];
  for (const [page, lines] of byPage) {
    const path = rendered.get(page);
    const size = pages[page - 1];
    if (!path || !size) throw new PdfToolError(`Страница ${page} не отрендерилась`, 'damaged');
    const raster = {
      page,
      widthPt: size.width,
      heightPt: size.height,
      image: await tools.loadGray(path),
    };
    boxes.push(...layoutNumberedLines(lines, new Map([[page, raster]]), pitch));
  }

  return {
    strategy: 'numbers',
    boxes,
    report: {
      firstPage: numbered.firstPage,
      lastPage: numbered.lastPage,
      anomalies: numbered.anomalies,
    },
  };
}
