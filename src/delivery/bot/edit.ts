import { GrammyError, type InlineKeyboard } from 'grammy';
import type { BotContext } from './context.js';

/** Ответ на кнопку: правим то же сообщение, чтобы шаги не копились в чате; не вышло — пишем новое. */
export async function editOrReply(ctx: BotContext, text: string, keyboard?: InlineKeyboard) {
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes('message is not modified')) return;
    await ctx.reply(text, { reply_markup: keyboard });
  }
}
