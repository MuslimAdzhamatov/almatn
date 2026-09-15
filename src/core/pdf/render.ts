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

/**
 * Вырезает фрагмент в PNG. Telegram отклоняет фото с соотношением сторон больше maxAspect:1,
 * поэтому слишком узкая полоса (одна строка на всю ширину) дополняется белыми полями сверху и снизу.
 */
export async function cropPng(path: string, rect: PixelRect, maxAspect = 20): Promise<Buffer> {
  const image = sharp(path).extract(rect);
  const minHeight = Math.ceil(rect.width / maxAspect);
  if (rect.height < minHeight) {
    const pad = minHeight - rect.height;
    image.extend({
      top: Math.floor(pad / 2),
      bottom: Math.ceil(pad / 2),
      background: '#ffffff',
    });
  }
  return image.png({ compressionLevel: 9 }).toBuffer();
}
