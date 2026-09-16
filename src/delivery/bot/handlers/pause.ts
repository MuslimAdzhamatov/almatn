import type { Bot } from 'grammy';
import type { Pause } from '../../../app/pause.js';
import type { BotContext } from '../context.js';
import { texts } from '../texts.js';
import { RESUME_CALLBACK } from '../views/pause.js';

const t = texts.pause;

export function registerPause(bot: Bot<BotContext>, pause: Pause) {
  bot.callbackQuery(RESUME_CALLBACK, async (ctx) => {
    const result = await pause.resume(ctx.user.id, new Date());
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    if (result.kind === 'not_paused') {
      await ctx.answerCallbackQuery({ text: t.notPaused });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(result.debtMessages > 0 ? t.resumedWithDebt : t.resumed);
  });
}
