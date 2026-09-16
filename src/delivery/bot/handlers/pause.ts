import type { Bot } from 'grammy';
import type { Pause, PauseScreen } from '../../../app/pause.js';
import type { BotContext } from '../context.js';
import { editOrReply } from '../edit.js';
import { texts } from '../texts.js';
import { PAUSE_SET_CALLBACK, renderPause, RESUME_CALLBACK } from '../views/pause.js';

const t = texts.pause;

async function show(ctx: BotContext, screen: PauseScreen, viaButton: boolean) {
  if (screen.kind === 'stale') {
    if (viaButton) await ctx.answerCallbackQuery({ text: texts.learn.stale });
    return;
  }
  const { text, keyboard } = renderPause(screen);
  if (!viaButton) {
    await ctx.reply(text, { reply_markup: keyboard });
    return;
  }
  if (screen.kind === 'not_paused') {
    await ctx.answerCallbackQuery({ text: t.notPaused });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    return;
  }
  await ctx.answerCallbackQuery();
  if (screen.kind === 'resumed') {
    // Сводка долга уже пришла выше — сообщение о продолжении отдельным сообщением ниже неё.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    await ctx.reply(text);
    return;
  }
  await editOrReply(ctx, text, keyboard);
}

export function registerPause(bot: Bot<BotContext>, pause: Pause) {
  bot.command('pause', async (ctx) => {
    await show(ctx, await pause.open(ctx.user.id, new Date()), false);
  });

  // «⏸ Пауза» в /settings.
  bot.callbackQuery('mg:pause', async (ctx) => {
    await show(ctx, await pause.open(ctx.user.id, new Date()), true);
  });

  bot.callbackQuery(RESUME_CALLBACK, async (ctx) => {
    await show(ctx, await pause.resume(ctx.user.id, new Date()), true);
  });

  bot.callbackQuery(PAUSE_SET_CALLBACK, async (ctx) => {
    await show(ctx, await pause.choose(ctx.user.id, ctx.match[1] ?? '', new Date()), true);
  });

  // Дата окончания паузы текстом.
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const screen = await pause.handleText(ctx.user.id, ctx.message.text, new Date());
    if (!screen) return next();
    await show(ctx, screen, false);
  });
}
