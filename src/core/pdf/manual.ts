import type { LineBox } from './layout.js';

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
    yTop: 0,
    yBottom: page.heightPt,
    xLeft: null,
    xRight: null,
    sectionBreakBefore: false,
  }));
}
