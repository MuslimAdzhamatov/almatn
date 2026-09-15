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

export function groupIntoSegments(boxes: readonly LineBox[]): CropSegment[] {
  const sorted = [...boxes].sort((a, b) => a.lineNumber - b.lineNumber);
  const segments: CropSegment[] = [];
  for (const box of sorted) {
    const last = segments.at(-1);
    if (last && last.page === box.page && last.lineEnd + 1 === box.lineNumber) {
      last.lineEnd = box.lineNumber;
      last.yTop = Math.min(last.yTop, box.yTop);
      last.yBottom = Math.max(last.yBottom, box.yBottom);
      last.xLeft = minNullable(last.xLeft, box.xLeft);
      last.xRight = maxNullable(last.xRight, box.xRight);
    } else {
      segments.push({
        page: box.page,
        lineStart: box.lineNumber,
        lineEnd: box.lineNumber,
        yTop: box.yTop,
        yBottom: box.yBottom,
        xLeft: box.xLeft,
        xRight: box.xRight,
      });
    }
  }
  return segments;
}

// null (вся ширина) поглощает любые конкретные границы.
const minNullable = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.min(a, b);
const maxNullable = (a: number | null, b: number | null) =>
  a === null || b === null ? null : Math.max(a, b);

/** Фрагмент в пунктах PDF → прямоугольник в пикселях отрендеренной страницы. */
export function segmentPixelRect(
  segment: CropSegment,
  page: { widthPt: number; heightPt: number },
  image: { width: number; height: number },
): PixelRect {
  const sx = image.width / page.widthPt;
  const sy = image.height / page.heightPt;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const left = clamp(Math.floor((segment.xLeft ?? 0) * sx), 0, image.width - 1);
  const right = clamp(Math.ceil((segment.xRight ?? page.widthPt) * sx), left + 1, image.width);
  const top = clamp(Math.floor(segment.yTop * sy), 0, image.height - 1);
  const bottom = clamp(Math.ceil(segment.yBottom * sy), top + 1, image.height);
  return { left, top, width: right - left, height: bottom - top };
}
