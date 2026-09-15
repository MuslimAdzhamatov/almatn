import { GrammyError, type Bot } from 'grammy';
import type { Onboarding, OnboardingScreen, OnboardingView } from '../../../app/onboarding.js';
import type { BotContext } from '../context.js';
import { callbacks } from '../keyboards.js';
import { texts } from '../texts.js';
import { renderOnboarding } from '../views/onboarding.js';

async function replyScreen(ctx: BotContext, screen: OnboardingScreen, prefix?: string) {
  const { text, keyboard } = renderOnboarding(screen, ctx.from?.first_name);
  await ctx.reply(prefix ? `${prefix}\n\n${text}` : text, { reply_markup: keyboard });
}

/** Ответ на нажатие кнопки: редактируем то же сообщение, чтобы в чате не копились шаги. */
async function editScreen(ctx: BotContext, view: OnboardingView) {
  if (view.kind === 'stale') {
    await ctx.answerCallbackQuery({ text: texts.onboarding.staleButton });
    await replyScreen(ctx, view.current);
    return;
  }
  await ctx.answerCallbackQuery();
  const { text, keyboard } = renderOnboarding(view, ctx.from?.first_name);
  try {
    await ctx.editMessageText(text, { reply_markup: keyboard });
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes('message is not modified')) return;
    await ctx.reply(text, { reply_markup: keyboard });
  }
}

function matched(ctx: BotContext): string {
  return Array.isArray(ctx.match) ? (ctx.match[1] ?? '') : '';
}

export function registerOnboarding(bot: Bot<BotContext>, onboarding: Onboarding) {
  bot.command('start', async (ctx) => {
    await replyScreen(ctx, await onboarding.start(ctx.user.id, new Date()));
  });

  bot.callbackQuery(new RegExp(`^${callbacks.zoneGroup}:(\\w+)$`), async (ctx) => {
    await editScreen(
      ctx,
      await onboarding.openTimezoneGroup(ctx.user.id, matched(ctx), new Date()),
    );
  });

  bot.callbackQuery(new RegExp(`^${callbacks.zone}:(.+)$`), async (ctx) => {
    await editScreen(ctx, await onboarding.pickTimezone(ctx.user.id, matched(ctx), new Date()));
  });

  bot.callbackQuery(callbacks.zoneYes, async (ctx) => {
    await editScreen(ctx, await onboarding.confirmTimezone(ctx.user.id, new Date()));
  });

  bot.callbackQuery(callbacks.zoneNo, async (ctx) => {
    await editScreen(ctx, await onboarding.rejectTimezone(ctx.user.id, new Date()));
  });

  bot.callbackQuery(new RegExp(`^${callbacks.sendTime}:(\\d{2}:\\d{2})$`), async (ctx) => {
    await editScreen(ctx, await onboarding.setSendTime(ctx.user.id, matched(ctx), new Date()));
  });

  bot.callbackQuery(new RegExp(`^${callbacks.night}:(\\w+)$`), async (ctx) => {
    await editScreen(
      ctx,
      await onboarding.chooseNightPolicy(ctx.user.id, matched(ctx), new Date()),
    );
  });

  // Пока настройка не завершена, любое сообщение ведёт в текущий шаг онбординга.
  bot.on('message', async (ctx, next) => {
    if (ctx.user.onboarded) return next();
    const now = new Date();
    const text = ctx.message.text;

    if (text !== undefined && !text.startsWith('/')) {
      const view = await onboarding.handleText(ctx.user.id, text, now);
      if (view.kind === 'stale') await replyScreen(ctx, view.current, texts.onboarding.useButtons);
      else await replyScreen(ctx, view);
      return;
    }

    await replyScreen(
      ctx,
      await onboarding.current(ctx.user.id, now),
      texts.onboarding.finishFirst,
    );
  });
}
