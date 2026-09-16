import { limits } from '../config/limits.js';
import {
  groupIntoSegments,
  segmentCacheKey,
  segmentPixelRect,
  typicalLineHeight,
  withMargin,
  type CropSegment,
} from '../core/pdf/crop.js';
import type { LineBox } from '../core/pdf/layout.js';
import type { CropCacheStore, FileStore, PdfTools, TextRecord } from './ports.js';

// Картинки единиц (CLAUDE.md, раздел 4.1, «Вырезка порций»): подряд идущие единицы одной страницы —
// одна картинка. Повторно отправляемые одинаковые вырезки берутся по Telegram file_id из CropCache.

export type ImageSource = Pick<TextRecord, 'id' | 'filePath' | 'sourceKind'>;

export interface LineImage {
  page: number;
  lineStart: number;
  lineEnd: number;
  png: Buffer;
}

/** Картинка для отправки: уже известный file_id или отрендеренный PNG. */
export interface OutgoingPicture {
  page: number;
  lineStart: number;
  lineEnd: number;
  cacheKey: string;
  fileId: string | null;
  png: Buffer | null;
}

export interface ImagesDeps {
  files: FileStore;
  tools: PdfTools;
  cache?: CropCacheStore;
}

export function createImages({ files, tools, cache }: ImagesDeps) {
  const dpi = limits.pdf.cropDpi;

  function segmentsOf(boxes: readonly LineBox[], marginSteps: number): CropSegment[] {
    const segments = groupIntoSegments(boxes);
    return marginSteps > 0 ? withMargin(segments, marginSteps, typicalLineHeight(boxes)) : segments;
  }

  async function renderSegment(text: ImageSource, segment: CropSegment): Promise<Buffer | null> {
    // Для текста из картинок координаты хранятся в пикселях страницы, поэтому масштаб равен 1.
    if (text.sourceKind === 'images') {
      const path = (await files.listImagePages(text.id))[segment.page - 1];
      if (!path) return null;
      const size = await tools.imageSize(path);
      const page = { widthPt: size.width, heightPt: size.height };
      return tools.crop(path, segmentPixelRect(segment, page, size));
    }
    const outDir = await files.pagesDir(text.id);
    const path = await tools.renderPage(text.filePath, { outDir, dpi, page: segment.page });
    const size = await tools.imageSize(path);
    const page = { widthPt: (size.width * 72) / dpi, heightPt: (size.height * 72) / dpi };
    return tools.crop(path, segmentPixelRect(segment, page, size));
  }

  return {
    /** Картинки единиц как PNG (сводка после разбора). */
    async render(
      text: ImageSource,
      boxes: readonly LineBox[],
      marginSteps = 0,
    ): Promise<LineImage[]> {
      const images: LineImage[] = [];
      for (const segment of segmentsOf(boxes, marginSteps)) {
        const png = await renderSegment(text, segment);
        if (png) images.push({ ...pick(segment), png });
      }
      return images;
    },

    /** Картинки для отправки: из кэша file_id, недостающие — рендером. */
    async pictures(
      text: ImageSource,
      boxes: readonly LineBox[],
      marginSteps = 0,
    ): Promise<OutgoingPicture[]> {
      const segments = segmentsOf(boxes, marginSteps);
      const keys = segments.map((segment) => segmentCacheKey(segment, dpi));
      const cached = cache ? await cache.get(text.id, keys) : new Map<string, string>();
      const pictures: OutgoingPicture[] = [];
      for (const [index, segment] of segments.entries()) {
        const cacheKey = keys[index]!;
        const fileId = cached.get(cacheKey) ?? null;
        const png = fileId ? null : await renderSegment(text, segment);
        if (fileId || png) pictures.push({ ...pick(segment), cacheKey, fileId, png });
      }
      return pictures;
    },

    /** Запомнить file_id отправленных картинок. */
    async remember(textId: number, sent: { cacheKey: string; fileId: string }[]) {
      if (cache && sent.length > 0) await cache.save(textId, sent);
    },
  };
}

function pick(segment: CropSegment) {
  return { page: segment.page, lineStart: segment.lineStart, lineEnd: segment.lineEnd };
}

export type Images = ReturnType<typeof createImages>;
