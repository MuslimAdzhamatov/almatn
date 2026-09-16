import { textFragment, type LineBox } from './layout.js';

// Ручной режим (CLAUDE.md, раздел 4.1, стратегия 4): единица заучивания — страница целиком.

export interface PageSize {
  page: number;
  widthPt: number;
  heightPt: number;
}

export function pagesAsUnits(pages: readonly PageSize[]): LineBox[] {
  return pages.map((page, index) => ({
    lineNumber: index + 1,
    printedNumber: null,
    page: page.page,
    sectionBreakBefore: false,
    fragments: [textFragment(page.page, 0, page.heightPt)],
  }));
}

/**
 * Ручной режим «N строк со страницы» (стратегия 5): страница делится на равные полосы.
 * Нужен, когда автоматика не справилась с вёрсткой, а строки на странице идут ровно.
 */
export function pagesAsSlices(pages: readonly PageSize[], perPage: number): LineBox[] {
  if (perPage < 1) throw new Error('Строк со страницы должно быть не меньше одной');
  const boxes: LineBox[] = [];
  for (const page of pages) {
    for (let index = 0; index < perPage; index++) {
      boxes.push({
        lineNumber: boxes.length + 1,
        printedNumber: null,
        page: page.page,
        sectionBreakBefore: false,
        fragments: [
          textFragment(
            page.page,
            (page.heightPt * index) / perPage,
            (page.heightPt * (index + 1)) / perPage,
          ),
        ],
      });
    }
  }
  return boxes;
}
