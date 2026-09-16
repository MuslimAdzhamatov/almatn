import type { LineBox } from './layout.js';

// Порция строк → фрагменты для вырезки: подряд идущие строки одной страницы — одна картинка.

export interface CropSegment {
  page: number;
  lineStart: number;
  lineEnd: number;
  yTop: number;
  yBottom: number;
  xLeft: number | null;
  xRight: number | null;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Фрагменты единиц → картинки: всё, что идёт подряд на одной странице, попадает в одну вырезку.
 * Заголовок раздела перед первой строкой порции входит в неё, потому что лежит на той же странице выше.
 */
export function groupIntoSegments(boxes: readonly LineBox[]): CropSegment[] {
  const sorted = [...boxes].sort((a, b) => a.lineNumber - b.lineNumber);
  const segments: CropSegment[] = [];
  for (const box of sorted) {
    for (const fragment of box.fragments) {
      const last = segments.at(-1);
      const continues =
        last &&
        last.page === fragment.page &&
        (box.lineNumber === last.lineEnd || box.lineNumber === last.lineEnd + 1);
      if (last && continues) {
        last.lineEnd = box.lineNumber;
        last.yTop = Math.min(last.yTop, fragment.yTop);
        last.yBottom = Math.max(last.yBottom, fragment.yBottom);
        last.xLeft = minNullable(last.xLeft, fragment.xLeft);
        last.xRight = maxNullable(last.xRight, fragment.xRight);
      } else {
        segments.push({
          page: fragment.page,
          lineStart: box.lineNumber,
          lineEnd: box.lineNumber,
          yTop: fragment.yTop,
          yBottom: fragment.yBottom,
          xLeft: fragment.xLeft,
          xRight: fragment.xRight,
        });
      }
    }
  }
  return segments;
}

// null (вся ширина) поглощает любые конкретные границы.
const minNullable = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.min(a, b);
const maxNullable = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.max(a, b);

/**
 * Запас по бокам, если границы строки найдены по чернилам (разбор по изображению, абзацы):
 * крайние буквы не должны упираться в край картинки. Соседних строк сбоку нет, поэтому запас безопасен.
 */
export const SIDE_PADDING_SHARE = 0.03;

/** Меняется при любом изменении правил вырезки — старые Telegram file_id из кэша не используются. */
export const CROP_STYLE_VERSION = 2;

/** Фрагмент в пунктах PDF → прямоугольник в пикселях отрендеренной страницы. */
export function segmentPixelRect(
  segment: CropSegment,
  page: { widthPt: number; heightPt: number },
  image: { width: number; height: number },
): PixelRect {
  const sx = image.width / page.widthPt;
  const sy = image.height / page.heightPt;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const side = SIDE_PADDING_SHARE * page.widthPt;
  const xLeft = segment.xLeft === null ? 0 : segment.xLeft - side;
  const xRight = segment.xRight === null ? page.widthPt : segment.xRight + side;
  const left = clamp(Math.floor(xLeft * sx), 0, image.width - 1);
  const right = clamp(Math.ceil(xRight * sx), left + 1, image.width);
  const top = clamp(Math.floor(segment.yTop * sy), 0, image.height - 1);
  const bottom = clamp(Math.ceil(segment.yBottom * sy), top + 1, image.height);
  return { left, top, width: right - left, height: bottom - top };
}

/** «Захватить больше»: каждое нажатие добавляет сверху и снизу 40% высоты строки. */
export const CONTEXT_MARGIN_SHARE = 0.4;

/** Обычная высота строки порции — медиана высот текстовых фрагментов. */
export function typicalLineHeight(boxes: readonly LineBox[]): number {
  const heights = boxes
    .flatMap((box) => box.fragments)
    .filter((fragment) => fragment.kind === 'text')
    .map((fragment) => fragment.yBottom - fragment.yTop)
    .sort((a, b) => a - b);
  return heights[Math.floor(heights.length / 2)] ?? 0;
}

/** Вырезки с вертикальным запасом; за край страницы не выходят (см. segmentPixelRect). */
export function withMargin(
  segments: readonly CropSegment[],
  steps: number,
  lineHeight: number,
): CropSegment[] {
  const margin = steps * CONTEXT_MARGIN_SHARE * lineHeight;
  return segments.map((segment) => ({
    ...segment,
    yTop: Math.max(0, segment.yTop - margin),
    yBottom: segment.yBottom + margin,
  }));
}

/** Ключ кэша Telegram file_id: одинаковая вырезка той же страницы — та же картинка. */
export function segmentCacheKey(segment: CropSegment, dpi: number): string {
  const r = (value: number | null) => (value === null ? '' : value.toFixed(1));
  return [
    `v${CROP_STYLE_VERSION}`,
    segment.page,
    r(segment.yTop),
    r(segment.yBottom),
    r(segment.xLeft),
    r(segment.xRight),
    dpi,
  ].join(':');
}
