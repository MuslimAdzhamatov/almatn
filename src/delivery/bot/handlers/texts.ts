import { extname } from 'node:path';
import { GrammyError, type Bot } from 'grammy';
import { limits } from '../../../config/limits.js';
import type { FileStore } from '../../../app/ports.js';
import {
  classifyUpload,
  type IncomingFile,
  type TextAction,
  type Texts,
} from '../../../app/texts.js';
import type { Logger } from '../../../lib/logger.js';
import type { BotContext } from '../context.js';
import { downloadTelegramFile } from '../download.js';
import { editOrReply } from '../edit.js';
import { sendImages } from '../images.js';
import { texts } from '../texts.js';
import {
  actionMessage,
  imageCaption,
  imagesKeyboard,
  ingestText,
  parseFailedText,
  parseSummaryKeyboard,
  pendingQuestion,
  reparseKeyboard,
  summaryText,
  textCallbacks,
  uploadCheckText,
} from '../views/texts.js';

export interface TextsHandlersDeps {
  texts: Texts;
  files: FileStore;
  token: string;
  logger: Logger;
  /** Текст сохранён — дальше создание плана. */
  onSaved?: (ctx: BotContext, textId: number) => Promise<void>;
}

export interface TextsHandlers {
  /** Файлы, присланные до конца настройки расписания: обрабатываются сразу после неё. */
  processPending(ctx: BotContext): Promise<void>;
}

const matchedId = (ctx: BotContext) => (Array.isArray(ctx.match) ? Number(ctx.match[1]) : NaN);
const matchedArg = (ctx: BotContext) => (Array.isArray(ctx.match) ? (ctx.match[2] ?? '') : '');

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

export function registerTexts(bot: Bot<BotContext>, deps: TextsHandlersDeps): TextsHandlers {
  /** Показывает результат; после сохранения текста переходит к созданию плана. */
  async function show(ctx: BotContext, action: TextAction, viaButton: boolean) {
    await showAction(ctx, action, viaButton);
    if (action.kind === 'saved') await deps.onSaved?.(ctx, action.textId);
  }

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

  /**
   * Страница-картинка: копится до кнопки «Готово». Бот не отвечает на каждую картинку альбома,
   * а обновляет одно сообщение со счётчиком страниц.
   */
  async function collectImage(ctx: BotContext, file: IncomingFile, fromPhoto: boolean) {
    const userId = ctx.user.id;
    const added = await deps.texts.addImagePage(userId, file);
    if (added.kind === 'too_many') {
      await ctx.reply(texts.upload.imagesTooMany(added.limit));
      return;
    }

    const body = [texts.upload.imageCollected(added.pages, limits.images.maxPages)];
    if (fromPhoto && added.pages === 1) body.push(texts.upload.photoAdvice);
    const message = body.join('\n\n');
    const keyboard = imagesKeyboard(added.pages);

    const previous = await deps.texts.imagesMessage(userId);
    if (previous !== null) {
      try {
        await ctx.api.editMessageText(Number(userId), previous, message, {
          reply_markup: keyboard,
        });
        return;
      } catch (err) {
        // Сообщение могли удалить — отправим новое.
        if (!(err instanceof GrammyError)) throw err;
      }
    }
    const sent = await ctx.reply(message, { reply_markup: keyboard });
    await deps.texts.setImagesMessage(userId, sent.message_id);
  }

  /** Проверка → скачивание → постановка в очередь разбора. */
  async function receiveFile(ctx: BotContext, file: IncomingFile, fromPhoto = false) {
    const userId = ctx.user.id;
    const chatId = Number(userId);

    // Настройка расписания ещё идёт: файл не теряем, вернёмся к нему сразу после неё.
    if (!ctx.user.onboarded) {
      await deps.texts.stashFile(userId, file);
      await ctx.reply(texts.upload.savedUntilOnboarded);
      return;
    }

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
    if (check.upload === 'image') {
      await collectImage(ctx, file, fromPhoto);
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
      fileUniqueId: document.file_unique_id,
      fileName: document.file_name ?? 'document.pdf',
      mimeType: document.mime_type,
      fileSize: document.file_size,
      mediaGroupId: ctx.message.media_group_id,
    });
  });

  // Фото: Telegram отдаёт несколько размеров, берём самый большой.
  bot.on('message:photo', async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    await receiveFile(
      ctx,
      {
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        fileName: `${photo.file_unique_id}.jpg`,
        mimeType: 'image/jpeg',
        fileSize: photo.file_size,
        mediaGroupId: ctx.message.media_group_id,
      },
      true,
    );
  });

  // «Готово, это все страницы» — скачиваем накопленные картинки и создаём текст.
  bot.callbackQuery(new RegExp(`^${textCallbacks.images}:(\\w+)$`), async (ctx) => {
    const userId = ctx.user.id;
    const chatId = Number(userId);
    const action = Array.isArray(ctx.match) ? (ctx.match[1] ?? '') : '';

    if (action === 'cancel') {
      await deps.texts.clearUploads(userId);
      await ctx.answerCallbackQuery();
      await editOrReply(ctx, texts.upload.imagesCancelled);
      return;
    }
    if (action !== 'done') {
      await ctx.answerCallbackQuery({ text: texts.upload.stale });
      return;
    }

    const pages = await deps.texts.pendingUploads(userId);
    if (pages.length === 0) {
      await ctx.answerCallbackQuery({ text: texts.upload.imagesEmpty });
      return;
    }

    await ctx.answerCallbackQuery();
    await editOrReply(ctx, texts.upload.downloading);

    const downloaded: { tempPath: string; extension: string; fileSize: number }[] = [];
    try {
      for (const page of pages) {
        const extension = extname(page.fileName).toLowerCase() || '.jpg';
        const tempPath = await deps.files.tempPath(extension);
        const fileSize = await downloadTelegramFile(ctx.api, deps.token, page.fileId, tempPath);
        downloaded.push({ tempPath, extension, fileSize });
      }
    } catch (err) {
      for (const page of downloaded) await deps.files.removeFile(page.tempPath);
      deps.logger.error(
        { error: err instanceof Error ? err.message : String(err), userId: String(userId) },
        'Не удалось скачать картинку',
      );
      await ctx.api.sendMessage(chatId, texts.upload.downloadFailed);
      return;
    }

    const result = await deps.texts.ingestImages({
      userId,
      fileName: pages[0]!.fileName,
      pages: downloaded,
    });
    await ctx.api.sendMessage(chatId, ingestText(result));
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
    await show(ctx, await deps.texts.confirm(ctx.user.id, matchedId(ctx)), true);
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.unit}:(\\d+):(\\w+)$`), async (ctx) => {
    await show(ctx, await deps.texts.setUnit(ctx.user.id, matchedId(ctx), matchedArg(ctx)), true);
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.reparse}:(\\d+):(\\w+)$`), async (ctx) => {
    await show(ctx, await deps.texts.reparse(ctx.user.id, matchedId(ctx), matchedArg(ctx)), true);
  });

  // Меню «Разобрать по-другому» и возврат из него к подтверждению.
  bot.callbackQuery(new RegExp(`^${textCallbacks.reparseMenu}:(\\d+):(\\w+)$`), async (ctx) => {
    const summary = await deps.texts.summary(matchedId(ctx));
    if (!summary) {
      await ctx.answerCallbackQuery({ text: texts.upload.stale });
      return;
    }
    await ctx.answerCallbackQuery();
    const back = matchedArg(ctx) === 'back';
    await editOrReply(
      ctx,
      back
        ? texts.upload.confirmPrompt
        : texts.upload.reparseMenu(
            summary.report.firstPage,
            summary.report.lastPage,
            summary.pageCount,
          ),
      back ? parseSummaryKeyboard(summary) : reparseKeyboard(summary),
    );
  });

  // Ввод диапазона страниц или числа полос со страницы.
  bot.callbackQuery(new RegExp(`^${textCallbacks.reparseInput}:(\\d+):(\\w+)$`), async (ctx) => {
    await show(
      ctx,
      await deps.texts.askReparseInput(ctx.user.id, matchedId(ctx), matchedArg(ctx)),
      true,
    );
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.cancel}:(\\d+)$`), async (ctx) => {
    await show(ctx, await deps.texts.cancel(ctx.user.id, matchedId(ctx)), true);
  });

  bot.callbackQuery(new RegExp(`^${textCallbacks.keepTitle}:(\\d+)$`), async (ctx) => {
    await show(ctx, await deps.texts.keepTitle(ctx.user.id, matchedId(ctx)), true);
  });

  // Ответ текстом: диапазон страниц и число полос со страницы, затем название после «Всё верно».
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const reparse = await deps.texts.handleReparseText(ctx.user.id, ctx.message.text);
    if (reparse) {
      await show(ctx, reparse, false);
      return;
    }
    const action = await deps.texts.handleTitleText(ctx.user.id, ctx.message.text);
    if (!action) return next();
    await show(ctx, action, false);
  });

  return {
    async processPending(ctx: BotContext) {
      const userId = ctx.user.id;
      const pending = await deps.texts.pendingUploads(userId);
      const first = pending[0];
      if (!first) return;

      await ctx.reply(texts.upload.backToPendingFile);
      const file: IncomingFile = {
        fileId: first.fileId,
        fileUniqueId: first.fileUniqueId ?? undefined,
        fileName: first.fileName,
        mimeType: first.mimeType ?? undefined,
        fileSize: first.fileSize ?? undefined,
      };

      // PDF разбирается сразу; картинки ждут кнопку «Готово», их может быть больше одной.
      if (classifyUpload(file) === 'pdf') {
        await deps.texts.clearUploads(userId);
        await receiveFile(ctx, file);
        return;
      }
      const sent = await ctx.reply(
        texts.upload.imageCollected(pending.length, limits.images.maxPages),
        { reply_markup: imagesKeyboard(pending.length) },
      );
      await deps.texts.setImagesMessage(userId, sent.message_id);
    },
  };
}
