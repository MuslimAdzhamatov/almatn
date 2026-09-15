import { describe, expect, it } from 'vitest';
import type { PdfPageWords } from '../core/pdf/bbox.js';
import { parsePdf } from './parsing.js';
import type { PdfTools } from './ports.js';

const LINES_PER_PAGE = 5;

function numberedPage(page: number): PdfPageWords {
  const first = (page - 1) * LINES_PER_PAGE + 1;
  return {
    page,
    width: 595,
    height: 842,
    words: Array.from({ length: LINES_PER_PAGE }, (_, i) => ({
      text: `(${first + i})`,
      xMin: 523,
      xMax: 543,
      yMin: 100 + i * 60,
      yMax: 125 + i * 60,
    })),
  };
}

describe('parsePdf', () => {
  it('большой документ рендерится частями, страницы части удаляются после анализа', async () => {
    const pageCount = 120;
    const renders: [number, number][] = [];
    const discarded: string[] = [];
    const tools: PdfTools = {
      info: async () => ({ pages: pageCount }),
      words: async () => Array.from({ length: pageCount }, (_, i) => numberedPage(i + 1)),
      render: async (_file, { firstPage = 1, lastPage = pageCount }) => {
        renders.push([firstPage, lastPage]);
        return new Map(
          Array.from({ length: lastPage - firstPage + 1 }, (_, i) => [
            firstPage + i,
            `gray-${firstPage + i}`,
          ]),
        );
      },
      renderPage: async (_file, { page }) => `page-${page}`,
      loadGray: async () => ({
        width: 827,
        height: 1170,
        data: new Uint8Array(827 * 1170).fill(255),
      }),
      imageSize: async () => ({ width: 1654, height: 2339 }),
      crop: async () => Buffer.alloc(0),
    };

    const parsed = await parsePdf('/book.pdf', '/work', tools, 'auto', async (path) => {
      discarded.push(path);
    });

    expect(parsed.strategy).toBe('numbers');
    expect(parsed.boxes.map((box) => box.lineNumber)).toEqual(
      Array.from({ length: pageCount * LINES_PER_PAGE }, (_, i) => i + 1),
    );
    expect(renders).toEqual([
      [1, 50],
      [51, 100],
      [101, 120],
    ]);
    expect(discarded).toHaveLength(pageCount);
  });
});
