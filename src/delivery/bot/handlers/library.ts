import type { Bot } from 'grammy';
import type { Library, LibraryScreen } from '../../../app/library.js';
import type { PaceEdit, PaceEditScreen } from '../../../app/paceEdit.js';
import type { BotContext } from '../context.js';
import { editOrReply } from '../edit.js';
import { texts } from '../texts.js';
import { LIBRARY_CALLBACK, renderLibrary } from '../views/library.js';
import type { RenderedMessage } from '../views/onboarding.js';
import { PACE_EDIT_CALLBACK, renderPaceEdit } from '../views/paceEdit.js';

// /texts, /progress, /today, /help, смена темпа и удаление данных (CLAUDE.md, раздел 5.5).

export interface LibraryHandlersDeps {
  library: Library;
  paceEdit: PaceEdit;
  /** «Составить план» — диалог создания плана. */
  beginPlan: (ctx: BotContext, textId: number) => Promise<void>;
}

async function reply(ctx: BotContext, { text, keyboard }: RenderedMessage, viaButton: boolean) {
  if (viaButton) await editOrReply(ctx, text, keyboard);
  else await ctx.reply(text, { reply_markup: keyboard });
}

async function showLibrary(ctx: BotContext, screen: LibraryScreen, viaButton: boolean) {
  if (screen.kind === 'stale') {
    if (viaButton) await ctx.answerCallbackQuery({ text: texts.learn.stale });
    return;
  }
  if (screen.kind === 'debt_sent') {
    await ctx.answerCallbackQuery({
      text: screen.messages > 0 ? texts.library.debtSent : texts.library.noDebt,
    });
    return;
  }
  if (viaButton) await ctx.answerCallbackQuery();
  await reply(ctx, renderLibrary(screen), viaButton);
}

async function showPace(ctx: BotContext, screen: PaceEditScreen, viaButton: boolean) {
  if (screen.kind === 'stale') {
    if (viaButton) await ctx.answerCallbackQuery({ text: texts.learn.stale });
    return;
  }
  if (viaButton) await ctx.answerCallbackQuery();
  await reply(ctx, renderPaceEdit(screen), viaButton);
}

export function registerLibrary(bot: Bot<BotContext>, deps: LibraryHandlersDeps) {
  const { library, paceEdit } = deps;

  bot.command('texts', async (ctx) => {
    await showLibrary(ctx, await library.texts(ctx.user.id, new Date()), false);
  });
  bot.command('progress', async (ctx) => {
    await showLibrary(ctx, await library.progress(ctx.user.id, new Date()), false);
  });
  bot.command('today', async (ctx) => {
    await showLibrary(ctx, await library.today(ctx.user.id, new Date()), false);
  });
  bot.command('help', async (ctx) => {
    await ctx.reply(texts.help);
  });

  // Кнопки из /settings.
  bot.callbackQuery('mg:pace', async (ctx) => {
    await showLibrary(ctx, await library.pick(ctx.user.id, 'pace'), true);
  });
  bot.callbackQuery('mg:del', async (ctx) => {
    await showLibrary(ctx, await library.pick(ctx.user.id, 'delete'), true);
  });
  bot.callbackQuery('mg:wipe', async (ctx) => {
    await showLibrary(ctx, library.askWipe(1), true);
  });

  bot.callbackQuery(LIBRARY_CALLBACK, async (ctx) => {
    const [, action = '', idArg] = ctx.match;
    const id = Number(idArg);
    const userId = ctx.user.id;
    const now = new Date();
    switch (action) {
      case 'list':
        return showLibrary(ctx, await library.texts(userId, now), true);
      case 'card':
        return showLibrary(ctx, await library.card(userId, id, now), true);
      case 'upload':
        await ctx.answerCallbackQuery();
        await ctx.reply(texts.library.uploadHint);
        return;
      case 'plan':
        await ctx.answerCallbackQuery();
        await deps.beginPlan(ctx, id);
        return;
      case 'debt':
        return showLibrary(ctx, await library.sendDebt(userId, id, now), true);
      case 'del':
        return showLibrary(ctx, await library.askDelete(userId, id), true);
      case 'delok':
        return showLibrary(ctx, await library.deleteText(userId, id), true);
      case 'wipe2':
        return showLibrary(ctx, library.askWipe(2), true);
      case 'wipeok':
        return showLibrary(ctx, await library.wipe(userId), true);
    }
    await ctx.answerCallbackQuery({ text: texts.learn.stale });
  });

  bot.callbackQuery(PACE_EDIT_CALLBACK, async (ctx) => {
    const [, id = '', action = '', arg = ''] = ctx.match;
    const planId = Number(id);
    const now = new Date();
    const screen =
      action === 'open'
        ? await paceEdit.open(ctx.user.id, planId, now)
        : await paceEdit.act(ctx.user.id, planId, action, arg, now);
    await showPace(ctx, screen, true);
  });

  // Ответ текстом в диалоге смены темпа.
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const screen = await paceEdit.handleText(ctx.user.id, ctx.message.text, new Date());
    if (!screen) return next();
    await showPace(ctx, screen, false);
  });
}
