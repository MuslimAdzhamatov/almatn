import { GrammyError, type Api } from 'grammy';
import type { Notifier, NotifierPicture, SendResult, UnitLabel } from '../../app/ports.js';
import { sendImages } from './images.js';
import type { RenderedMessage } from './views/onboarding.js';
import { pictureCaption, portionMessage, reminderMessage } from './views/learning.js';
import { autoPauseMessage } from './views/pause.js';
import { batchMessage } from './views/reviews.js';

// Отправка сообщений планировщиком (CLAUDE.md, раздел 5.6): сценарии не знают про Telegram.

/** Пользователь заблокировал бота или удалил аккаунт — рассылку ему нужно остановить. */
const isBlocked = (err: unknown) =>
  err instanceof GrammyError &&
  (err.error_code === 403 ||
    (err.error_code === 400 && err.description.includes('chat not found')));

async function attempt(
  send: () => Promise<Omit<SendResult & { ok: true }, 'ok'>>,
): Promise<SendResult> {
  try {
    return { ok: true, ...(await send()) };
  } catch (err) {
    return { ok: false, reason: isBlocked(err) ? 'blocked' : 'error', error: err };
  }
}

function images(unit: UnitLabel, pictures: readonly NotifierPicture[]) {
  return pictures.map((picture) => ({
    png: picture.png,
    fileId: picture.fileId,
    fileName: `lines-${picture.lineStart}-${picture.lineEnd}.png`,
    caption: pictureCaption(unit, picture.lineStart, picture.lineEnd),
  }));
}

/** api передаётся функцией: бот создаётся после сценариев, которым нужен Notifier. */
export function createNotifier(api: () => Api): Notifier {
  /** Картинки, затем сообщение с кнопками (у альбома кнопок быть не может). */
  const withButtons = (
    userId: bigint,
    unit: UnitLabel,
    pictures: readonly NotifierPicture[],
    message: RenderedMessage,
  ) =>
    attempt(async () => {
      const chatId = Number(userId);
      const sent = await sendImages(api(), chatId, images(unit, pictures));
      const buttons = await api().sendMessage(chatId, message.text, {
        reply_markup: message.keyboard,
      });
      return {
        messageIds: [...sent.messageIds, buttons.message_id],
        buttonsMessageId: buttons.message_id,
        fileIds: sent.fileIds,
      };
    });

  return {
    sendPortion: (userId, view, pictures) =>
      withButtons(userId, view, pictures, portionMessage(view)),

    sendBatch: (userId, view, pictures) => withButtons(userId, view, pictures, batchMessage(view)),

    sendLearnReminder: (userId, view) =>
      attempt(async () => {
        const { text, keyboard } = reminderMessage(view);
        const message = await api().sendMessage(Number(userId), text, { reply_markup: keyboard });
        return {
          messageIds: [message.message_id],
          buttonsMessageId: message.message_id,
          fileIds: [],
        };
      }),

    sendPictures: (userId, unit, pictures) =>
      attempt(async () => {
        const sent = await sendImages(api(), Number(userId), images(unit, pictures));
        return { ...sent, buttonsMessageId: null };
      }),

    sendText: (userId, text) =>
      attempt(async () => {
        const message = await api().sendMessage(Number(userId), text);
        return { messageIds: [message.message_id], buttonsMessageId: null, fileIds: [] };
      }),

    sendAutoPause: (userId) =>
      attempt(async () => {
        const { text, keyboard } = autoPauseMessage();
        const message = await api().sendMessage(Number(userId), text, { reply_markup: keyboard });
        return {
          messageIds: [message.message_id],
          buttonsMessageId: message.message_id,
          fileIds: [],
        };
      }),

    async clearButtons(userId, messageId) {
      await api().editMessageReplyMarkup(Number(userId), messageId, { reply_markup: undefined });
    },
  };
}
