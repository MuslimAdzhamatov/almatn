import type { Bot } from 'grammy';
import type { Learning } from '../../../app/learning.js';
import type { PaceNotice } from '../../../app/pace.js';
import type { BotContext } from '../context.js';
import { texts } from '../texts.js';
import { PACE_CALLBACK, paceChoiceMessage, paceMessage } from '../views/pace.js';

/** Сообщение о сдвиге срока или выбор «Успеть к сроку» / «Сдвинуть срок». */
export async function replyPace(ctx: BotContext, notice: PaceNotice | null) {
  if (!notice) return;
  const { text, keyboard } = paceMessage(notice);
  await ctx.reply(text, { reply_markup: keyboard });
}

export function registerPace(bot: Bot<BotContext>, learning: Learning) {
  bot.callbackQuery(PACE_CALLBACK, async (ctx) => {
    const [, id = '', action = ''] = ctx.match;
    const choice = action === 'c' ? 'catch_up' : 'shift';
    const result = await learning.choosePace(ctx.user.id, Number(id), choice, new Date());
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    if (result.kind === 'stale') {
      await ctx.answerCallbackQuery({ text: texts.learn.stale });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(paceChoiceMessage(result));
  });
}
