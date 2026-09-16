import { InputFile, InputMediaBuilder, type Api } from 'grammy';
import type { Message, PhotoSize } from 'grammy/types';

export interface OutgoingImage {
  /** PNG для загрузки или уже известный Telegram file_id. */
  png?: Buffer | null;
  fileId?: string | null;
  fileName: string;
  caption?: string;
}

export interface SentImages {
  messageIds: number[];
  /** file_id каждой картинки по порядку — для кэша вырезок. */
  fileIds: (string | null)[];
}

const media = (image: OutgoingImage) =>
  image.fileId ?? new InputFile(image.png ?? Buffer.alloc(0), image.fileName);

const largest = (photo: PhotoSize[] | undefined) => photo?.at(-1)?.file_id ?? null;

/**
 * Отправляет картинки: одна — sendPhoto, несколько — альбомами по 10 (лимит Telegram).
 * У альбома не может быть кнопок, поэтому кнопки всегда отправляются отдельным сообщением после картинок.
 */
export async function sendImages(
  api: Api,
  chatId: number,
  images: readonly OutgoingImage[],
): Promise<SentImages> {
  const sent: Message[] = [];
  for (let i = 0; i < images.length; i += 10) {
    const chunk = images.slice(i, i + 10);
    const [single] = chunk;
    if (chunk.length === 1 && single) {
      sent.push(await api.sendPhoto(chatId, media(single), { caption: single.caption }));
    } else {
      sent.push(
        ...(await api.sendMediaGroup(
          chatId,
          chunk.map((image) => InputMediaBuilder.photo(media(image), { caption: image.caption })),
        )),
      );
    }
  }
  return {
    messageIds: sent.map((message) => message.message_id),
    fileIds: sent.map((message) => ('photo' in message ? largest(message.photo) : null)),
  };
}
