import sharp from 'sharp';
import type { PixelRect } from './crop.js';
import type { GrayImage } from './layout.js';

// Адаптер к sharp: чтение отрендеренных страниц и вырезка фрагментов (работает в пуле потоков libuv).

export async function loadGray(path: string): Promise<GrayImage> {
  const { data, info } = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    data: new Uint8Array(data.buffer, data.byteOffset, data.length),
  };
}

export async function imageSize(path: string): Promise<{ width: number; height: number }> {
  const { width, height } = await sharp(path).metadata();
  if (!width || !height) throw new Error(`Не удалось определить размер изображения ${path}`);
  return { width, height };
}

/** Белые поля вокруг каждой вырезки: текст не упирается в край картинки (доля ширины вырезки). */
export const WHITE_BORDER_SHARE = 0.02;

/**
 * Вырезает фрагмент в PNG и добавляет белые поля. Сверху и снизу — только поля, а не расширенная
 * вырезка, чтобы не захватить соседние строки. Telegram отклоняет фото с соотношением сторон
 * больше maxAspect:1, поэтому узкая полоса (одна строка на всю ширину) дополняется полями выше.
 */
export async function cropPng(path: string, rect: PixelRect, maxAspect = 20): Promise<Buffer> {
  const border = Math.max(8, Math.round(rect.width * WHITE_BORDER_SHARE));
  const width = rect.width + 2 * border;
  const height = Math.max(rect.height + 2 * border, Math.ceil(width / maxAspect));
  const vertical = height - rect.height;
  // Вырезку и поля делаем за два прохода: sharp применяет extract после extend, если звать их вместе.
  const cropped = await sharp(path).extract(rect).toBuffer();
  return sharp(cropped)
    .extend({
      left: border,
      right: border,
      top: Math.floor(vertical / 2),
      bottom: Math.ceil(vertical / 2),
      background: '#ffffff',
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
