import type { Bot } from 'grammy';
import { parseMask, type Learning, type PortionAction } from '../../../app/learning.js';
import type { BotContext } from '../context.js';
import { editOrReply } from '../edit.js';
import { texts } from '../texts.js';
import {
  contextKeyboard,
  learnedMessage,
  PORTION_CALLBACK,
  skipMenu,
  skippedMessage,
} from '../views/learning.js';

const t = texts.learn;

/** Под сообщением остаются только кнопки контекста (порция выучена) или ничего (напоминание). */
async function dropLearnButtons(ctx: BotContext, deliveryId: number, action: PortionAction) {
  if (action.kind !== 'learned' && action.kind !== 'already_learned') return;
  const keyboard = action.withContext ? contextKeyboard(deliveryId, action.portion) : undefined;
  await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch(() => undefined);
}

/** Ответ на нажатие: подсказка у кнопки и, если нужно, сообщение. */
async function show(ctx: BotContext, deliveryId: number, action: PortionAction, fromMenu: boolean) {
  switch (action.kind) {
    case 'learned':
      await ctx.answerCallbackQuery();
      await dropLearnButtons(ctx, deliveryId, action);
      await ctx.reply(learnedMessage(action));
      return;
    case 'already_learned':
      await ctx.answerCallbackQuery({ text: t.alreadyLearned });
      if (!fromMenu) await dropLearnButtons(ctx, deliveryId, action);
      else await ctx.deleteMessage().catch(() => undefined);
      return;
    case 'still_learning':
      await ctx.answerCallbackQuery({ text: t.stillLearning, show_alert: true });
      return;
    case 'remind_later': {
      const time = action.at.toLocaleTimeString('ru-RU', {
        timeZone: action.portion.timezone,
        hour: '2-digit',
        minute: '2-digit',
      });
      await ctx.answerCallbackQuery({ text: t.remindAt(time) });
      return;
    }
    case 'context_sent':
      await ctx.answerCallbackQuery();
      return;
    case 'context_limit':
      await ctx.answerCallbackQuery({ text: t.contextLimit(action.max) });
      return;
    case 'context_edge':
      await ctx.answerCallbackQuery({ text: action.direction === 'up' ? t.edgeUp : t.edgeDown });
      return;
    case 'skip_menu': {
      await ctx.answerCallbackQuery();
      const { text, keyboard } = skipMenu(action);
      if (fromMenu) await editOrReply(ctx, text, keyboard);
      else await ctx.reply(text, { reply_markup: keyboard });
      return;
    }
    case 'skipped':
      await ctx.answerCallbackQuery();
      if (fromMenu) await editOrReply(ctx, skippedMessage(action));
      else await ctx.reply(skippedMessage(action));
      return;
    case 'failed':
      await ctx.answerCallbackQuery({ text: t.failed });
      return;
    case 'stale':
      await ctx.answerCallbackQuery({ text: t.stale });
      if (fromMenu) await ctx.deleteMessage().catch(() => undefined);
      return;
  }
}

export function registerLearning(bot: Bot<BotContext>, learning: Learning) {
  bot.callbackQuery(PORTION_CALLBACK, async (ctx) => {
    const [, id = '', action = '', maskArg, indexArg] = ctx.match;
    const deliveryId = Number(id);
    const userId = ctx.user.id;
    const now = new Date();
    const mask = maskArg === undefined ? null : parseMask(maskArg);

    switch (action) {
      case 'ok':
        return show(ctx, deliveryId, await learning.learned(userId, deliveryId, now), false);
      case 'still':
        return show(ctx, deliveryId, await learning.stillLearning(userId, deliveryId), false);
      case 'later':
        return show(ctx, deliveryId, await learning.remindLater(userId, deliveryId, now), false);
      case 'more':
        return show(ctx, deliveryId, await learning.captureMore(userId, deliveryId, now), false);
      case 'up':
      case 'down':
        return show(
          ctx,
          deliveryId,
          await learning.neighbour(userId, deliveryId, action, now),
          false,
        );
      case 'skip':
        return show(ctx, deliveryId, await learning.skipMenu(userId, deliveryId, now), false);
      case 'skt':
        if (mask === null || indexArg === undefined) break;
        return show(
          ctx,
          deliveryId,
          await learning.toggleSkip(userId, deliveryId, mask, Number(indexArg)),
          true,
        );
      case 'sks':
        if (mask === null) break;
        return show(ctx, deliveryId, await learning.skip(userId, deliveryId, mask, now), true);
      case 'ska':
        return show(ctx, deliveryId, await learning.skip(userId, deliveryId, null, now), true);
      case 'skx':
        await ctx.answerCallbackQuery();
        await ctx.deleteMessage().catch(() => undefined);
        return;
    }
    await ctx.answerCallbackQuery({ text: t.stale });
  });
}
