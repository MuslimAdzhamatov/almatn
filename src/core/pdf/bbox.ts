// Разбор вывода `pdftotext -bbox`: слова с координатами (пункты PDF, начало — левый верхний угол).

export interface PdfWord {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface PdfPageWords {
  /** Номер страницы, с 1. */
  page: number;
  width: number;
  height: number;
  words: PdfWord[];
}

const PAGE = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
const WORD =
  /<word xMin="(-?[\d.]+)" yMin="(-?[\d.]+)" xMax="(-?[\d.]+)" yMax="(-?[\d.]+)">([^<]*)<\/word>/g;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[\da-f]+|\w+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code =
        entity[1]?.toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

export function parseBboxXhtml(xhtml: string): PdfPageWords[] {
  const pages: PdfPageWords[] = [];
  for (const [, width, height, body] of xhtml.matchAll(PAGE)) {
    const words: PdfWord[] = [];
    for (const [, xMin, yMin, xMax, yMax, text] of (body ?? '').matchAll(WORD)) {
      words.push({
        text: decodeEntities(text ?? ''),
        xMin: Number(xMin),
        yMin: Number(yMin),
        xMax: Number(xMax),
        yMax: Number(yMax),
      });
    }
    pages.push({ page: pages.length + 1, width: Number(width), height: Number(height), words });
  }
  return pages;
}
