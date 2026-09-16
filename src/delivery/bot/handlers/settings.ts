import type { Bot } from 'grammy';
import type { Settings, SettingsScreen } from '../../../app/settings.js';
import type { BotContext } from '../context.js';
import { editOrReply } from '../edit.js';
import { texts } from '../texts.js';
import { renderSettings, SETTINGS_CALLBACK } from '../views/settings.js';

async function show(ctx: BotContext, screen: SettingsScreen, viaButton: boolean) {
  if (screen.kind === 'stale') {
    if (viaButton) await ctx.answerCallbackQuery({ text: texts.learn.stale });
    return;
  }
  const { text, keyboard } = renderSettings(screen);
  if (viaButton) {
    await ctx.answerCallbackQuery();
    await editOrReply(ctx, text, keyboard);
  } else {
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

export function registerSettings(bot: Bot<BotContext>, settings: Settings) {
  bot.command('settings', async (ctx) => {
    await show(ctx, await settings.open(ctx.user.id, new Date()), false);
  });

  bot.callbackQuery(SETTINGS_CALLBACK, async (ctx) => {
    const [, action = '', arg = '', arg2 = ''] = ctx.match;
    await show(ctx, await settings.act(ctx.user.id, action, arg, arg2, new Date()), true);
  });

  // Ответ текстом: время, тихие часы, вечернее напоминание.
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const screen = await settings.handleText(ctx.user.id, ctx.message.text, new Date());
    if (!screen) return next();
    await show(ctx, screen, false);
  });
}
