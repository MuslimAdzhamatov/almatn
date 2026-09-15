import { InputFile, InputMediaBuilder, type Api } from 'grammy';

export interface OutgoingImage {
  png: Buffer;
  fileName: string;
  caption?: string;
}

/**
 * Отправляет картинки: одна — sendPhoto, несколько — альбомами по 10 (лимит Telegram).
 * У альбома не может быть кнопок, поэтому кнопки всегда отправляются отдельным сообщением после картинок.
 */
export async function sendImages(
  api: Api,
  chatId: number,
  images: readonly OutgoingImage[],
): Promise<number[]> {
  const messageIds: number[] = [];
  for (let i = 0; i < images.length; i += 10) {
    const chunk = images.slice(i, i + 10);
    const [single] = chunk;
    if (chunk.length === 1 && single) {
      const message = await api.sendPhoto(chatId, new InputFile(single.png, single.fileName), {
        caption: single.caption,
      });
      messageIds.push(message.message_id);
    } else {
      const messages = await api.sendMediaGroup(
        chatId,
        chunk.map((image) =>
          InputMediaBuilder.photo(new InputFile(image.png, image.fileName), {
            caption: image.caption,
          }),
        ),
      );
      messageIds.push(...messages.map((message) => message.message_id));
    }
  }
  return messageIds;
}
