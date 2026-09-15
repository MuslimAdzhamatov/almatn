import { GrammyError, type Bot, type InlineKeyboard } from 'grammy';
import type { FileStore } from '../../../app/ports.js';
import type { IncomingFile, TextAction, Texts } from '../../../app/texts.js';
import type { Logger } from '../../../lib/logger.js';
import type { BotContext } from '../context.js';
import { downloadTelegramFile } from '../download.js';
import { sendImages } from '../images.js';
import { texts } from '../texts.js';
import {
  actionMessage,
  imageCaption,
  ingestText,
  parseFailedText,
  parseSummaryKeyboard,
  pendingQuestion,
  summaryText,
  textCallbacks,
  uploadCheckText,
} from '../views/texts.js';

export interface TextsHandlersDeps {
  texts: Texts;
  files: FileStore;
  token: string;
  logger: Logger;
}

const matchedId = (ctx: BotContext) => (Array.isArray(ctx.match) ? Number(ctx.match[1]) : NaN);
const matchedArg = (ctx: BotContext) => (Array.isArray(ctx.match) ? (ctx.match[2] ?? '') : '');

async function editOrReply(ctx: BotContext, text: string, keyboard?: InlineKeyboard) {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes('message is not modified')) return;
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

async function showAction(ctx: BotContext, action: TextAction, viaButton: boolean) {
  if (action.kind === 'stale') {
    if (viaButton) await ctx.answerCallbackQuery({ text: texts.upload.stale });
    else await ctx.reply(texts.upload.staleTitle);
    return;
  }
  if (action.kind === 'unit_changed') {
    await ctx.answerCallbackQuery({ text: texts.upload.unitChanged(action.summary.unitName) });
    await ctx
      .editMessageReplyMarkup({ reply_markup: parseSummaryKeyboard(action.summary) })
      .catch(() => undefined);
    return;
  }
  const { text, keyboard } = actionMessage(action);
  if (viaButton) {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, text, keyboard);
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

export function registerTexts(bot: Bot<BotContext>, deps: TextsHandlersDeps) {
  /** Сводка разбора: текст → картинка первых строк → кнопки подтверждения. */
  async function sendSummary(chatId: number, textId: number) {
    const summary = await deps.texts.summary(textId);
    if (!summary) return;
    await bot.api.sendMessage(chatId, summaryText(summary));
    const images = await deps.texts.previewImages(textId);
    await sendImages(
      bot.api,
      chatId,
      images.map((image) => ({
        png: image.png,
        fileName: `lines-${image.lineStart}-${image.lineEnd}.png`,
        caption: imageCaption(summary, image),
      })),
    );
    await bot.api.sendMessage(chatId, texts.upload.confirmPrompt, {
      reply_markup: parseSummaryKeyboard(summary),
    });
  }

  /** Проверка → скачивание → постановка в очередь разбора. */
  async function receiveFile(ctx: BotContext, file: IncomingFile) {
    const userId = ctx.user.id;
    const chatId = Number(userId);
    const check = await deps.texts.checkUpload(userId, file);
    if (check.kind === 'pending_confirm') {
      const { text, keyboard } = pendingQuestion(check);
      await ctx.reply(text, { reply_markup: keyboard });
      return;
    }
    if (check.kind !== 'ok') {
      await ctx.reply(uploadCheckText(check));
      return;
    }

    const progress = await ctx.reply(texts.upload.downloading);
    const tempPath = await deps.files.tempPath('.pdf');
    let fileSize: number;
    try {
      fileSize = await downloadTelegramFile(ctx.api, deps.token, file.fileId, tempPath);
    } catch (err) {
      await deps.files.removeFile(tempPath);
      deps.logger.error(
        { error: err instanceof Error ? err.message : String(err), userId: String(userId) },
        'Не удалось скачать PDF',
      );
      await ctx.api.editMessageText(chatId, progress.message_id, texts.upload.downloadFailed);
      return;
    }

    const result = await deps.texts.ingest({
      userId,
      fileName: file.fileName,
      fileSize,
      tempPath,
    });
    await ctx.api.editMessageText(chatId, progress.message_id, ingestText(result));
  }

  // Итог фонового разбора.
  deps.texts.onParseEvent(async (event) => {
    if (event.kind === 'failed') {
      await bot.api.sendMessage(Number(event.userId), parseFailedText(event));
      return;
    }
    await sendSummary(Number(event.userId), event.textId);
  });

  bot.on('message:document', async (ctx) => {
    const document = ctx.message.document;
    await receiveFile(ctx, {
      fileId: document.file_id,
      fileName: document.file_name ?? 'document.pdf',
      mimeType: document.mime_type,
      fileSize: document.file_size,
    });
  });

  // Вопрос о неподтверждённом тексте: продолжить с ним или удалить и загрузить новый файл.
  bot.callbackQuery(new RegExp(`^${textCallbacks.pending}:([0-9a-f]+):(\\w+)$`), async (ctx) => {
    const token = Array.isArray(ctx.match) ? (ctx.match[1] ?? '') : '';
    const choice = await deps.texts.choosePending(ctx.user.id, token, matchedArg(ctx));
    if (choice.kind === 'stale') {
      await ctx.answerCallbackQuery({ text: texts.upload.stale });
      return;
    }
    await ctx.answerCallbackQuery();
    if (choice.kind === 'resume') {
      await editOrReply(ctx, texts.upload.pendingResumed(choice.title));
      await sendSummary(Number(ctx.user.id), choice.textId);
      return;
    }
    await editOrReply(ctx, texts.upload.pendingReplaced(choice.removedTitle));
    await receiveFile(ctx, choice.file);
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.confirm}:(\\d+)$`), async (ctx) => {
    await showAction(ctx, await deps.texts.confirm(ctx.user.id, matchedId(ctx)), true);
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.unit}:(\\d+):(\\w+)$`), async (ctx) => {
    await showAction(
      ctx,
      await deps.texts.setUnit(ctx.user.id, matchedId(ctx), matchedArg(ctx)),
      true,
    );
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.reparse}:(\\d+):(\\w+)$`), async (ctx) => {
    await showAction(
      ctx,
      await deps.texts.reparse(ctx.user.id, matchedId(ctx), matchedArg(ctx)),
      true,
    );
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.cancel}:(\\d+)$`), async (ctx) => {
    await showAction(ctx, await deps.texts.cancel(ctx.user.id, matchedId(ctx)), true);
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.keepTitle}:(\\d+)$`), async (ctx) => {
    await showAction(ctx, await deps.texts.keepTitle(ctx.user.id, matchedId(ctx)), true);
  });

  // Название текста на шаге после «Всё верно».
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const action = await deps.texts.handleTitleText(ctx.user.id, ctx.message.text);
    if (!action) return next();
    await showAction(ctx, action, false);
  });
}
