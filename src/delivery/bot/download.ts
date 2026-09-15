import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import type { Api } from 'grammy';

/**
 * Скачивает файл, присланный пользователем, в target. Возвращает размер в байтах.
 * В URL скачивания есть токен бота — он не должен попадать в тексты ошибок и логи.
 */
export async function downloadTelegramFile(
  api: Api,
  token: string,
  fileId: string,
  target: string,
): Promise<number> {
  const file = await api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram не вернул путь к файлу');
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok || !response.body) {
    throw new Error(`Не удалось скачать файл: HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body as ReadableStream), createWriteStream(target));
  return (await stat(target)).size;
}
