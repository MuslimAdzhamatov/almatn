import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutNumberedLines, type PageRaster } from './layout.js';
import { detectNumberedLines } from './numbers.js';
import { detectTextLines } from './textlines.js';
import { extractWords, pdfInfo, renderPages } from './poppler.js';
import { loadGray } from './render.js';

// Эталонные PDF из samples/ через настоящие poppler и sharp (CLAUDE.md, раздел 4.1, «Тесты»).

const SAMPLES = join(import.meta.dirname, '../../../samples');
const hasPoppler = spawnSync('pdftotext', ['-v']).error === undefined;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe.skipIf(!hasPoppler)('эталонные PDF', () => {
  it('manzuma-fiqh.pdf: 448 бейтов, опечатка на стр. 21, границы строк', async () => {
    const file = join(SAMPLES, 'manzuma-fiqh.pdf');
    expect(await pdfInfo(file)).toMatchObject({ pages: 33 });

    const pages = await extractWords(file);
    const parse = detectNumberedLines(pages);
    expect(parse?.lines.map((line) => line.lineNumber)).toEqual(range(1, 448));
    expect(parse?.anomalies).toEqual([
      { kind: 'misprint', page: 21, lineNumber: 286, printed: 276 },
    ]);
    expect(parse).toMatchObject({ firstPage: 2, lastPage: 32 });

    const dir = await mkdtemp(join(tmpdir(), 'almatn-test-'));
    try {
      const files = await renderPages(file, {
        outDir: dir,
        dpi: 100,
        gray: true,
        firstPage: parse!.firstPage,
        lastPage: parse!.lastPage,
      });
      const rasters = new Map<number, PageRaster>();
      for (const [page, path] of files) {
        const size = pages[page - 1]!;
        rasters.set(page, {
          page,
          widthPt: size.width,
          heightPt: size.height,
          image: await loadGray(path),
        });
      }
      const boxes = layoutNumberedLines(parse!.lines, rasters);

      // У строки, разобранной по номерам, ровно один фрагмент — сама строка.
      expect(boxes.every((box) => box.fragments.length === 1)).toBe(true);
      const heights = boxes.map((box) => box.fragments[0]!.yBottom - box.fragments[0]!.yTop);
      expect(Math.min(...heights)).toBeGreaterThan(20);
      expect(Math.max(...heights)).toBeLessThan(40);
      expect(boxes.find((box) => box.lineNumber === 10)?.sectionBreakBefore).toBe(true);
      expect(boxes.find((box) => box.lineNumber === 2)?.sectionBreakBefore).toBe(false);
      for (let i = 1; i < boxes.length; i++) {
        const [prev, cur] = [boxes[i - 1]!.fragments[0]!, boxes[i]!.fragments[0]!];
        if (prev.page === cur.page) expect(cur.yTop).toBeGreaterThanOrEqual(prev.yBottom - 0.01);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('sollam_wosol.pdf: основной текст — бейты 1–290 на стр. 8–28, разбор с повтором бейтов не мешает', async () => {
    const parse = detectNumberedLines(await extractWords(join(SAMPLES, 'sollam_wosol.pdf')));
    expect(parse).toMatchObject({ firstPage: 8, lastPage: 28 });
    expect(parse?.lines.map((line) => line.printedNumber)).toEqual(range(1, 290));
  }, 60_000);

  it('PDF без текстового слоя (скан): ни номеров, ни строк', async () => {
    const pages = await extractWords(join(SAMPLES, 'المقدمة الجزرية.pdf'));
    expect(detectNumberedLines(pages)).toBeNull();
    expect(detectTextLines(pages)).toBeNull();
  }, 60_000);

  it('manzuma-fiqh.pdf по строкам текста: те же бейты плюс заголовки разделов', async () => {
    const parse = detectTextLines(await extractWords(join(SAMPLES, 'manzuma-fiqh.pdf')));
    // Бейтов 448 (стр. 2–32); сверх них — концевая стр. 33 и короткие строки вступления.
    expect(parse?.lines.length).toBeGreaterThanOrEqual(448);
    expect(parse?.lines.length).toBeLessThan(500);
    expect(parse).toMatchObject({ firstPage: 2, lastPage: 33 });
    // Заголовки разделов («باب …») выше строк текста и в строки не попадают.
    expect(parse!.headings.length).toBeGreaterThan(50);
    const textHeight = parse!.lines[0]!.yMax - parse!.lines[0]!.yMin;
    for (const { line } of parse!.headings)
      expect(line.yMax - line.yMin).toBeGreaterThan(textHeight);
    // Колонтитул с номером страницы отсечён.
    expect(parse!.lines.every((line) => line.yMin < 800)).toBe(true);
  }, 60_000);

  it('متن عمدة الاحكام.pdf: текстовый слой сломан, по строкам не разбирается', async () => {
    const pages = await extractWords(join(SAMPLES, 'متن عمدة الاحكام.pdf'));
    expect(detectTextLines(pages)).toBeNull();
  }, 180_000);

  it('sollam_wosol.pdf по строкам текста: проза разбирается, колонтитул отсечён', async () => {
    const parse = detectTextLines(await extractWords(join(SAMPLES, 'sollam_wosol.pdf')));
    expect(parse?.lines.length).toBeGreaterThan(500);
    expect(parse?.firstPage).toBe(8);
    expect(parse!.lines.every((line) => line.yMin < 600)).toBe(true);
  }, 60_000);
});
