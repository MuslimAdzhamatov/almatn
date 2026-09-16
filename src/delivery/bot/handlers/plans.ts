import type { Bot } from 'grammy';
import type { Learning } from '../../../app/learning.js';
import type { PlanScreen, Plans } from '../../../app/plans.js';
import type { BotContext } from '../context.js';
import { editOrReply } from '../edit.js';
import { texts } from '../texts.js';
import { PLAN_CALLBACK, renderPlan } from '../views/plans.js';

export interface PlansHandlers {
  /** Начать диалог создания плана — сразу после сохранения текста. */
  begin(ctx: BotContext, textId: number): Promise<void>;
}

export function registerPlans(
  bot: Bot<BotContext>,
  plans: Plans,
  learning: Learning,
): PlansHandlers {
  async function showPlan(ctx: BotContext, screen: PlanScreen, viaButton: boolean) {
    if (screen.kind === 'stale') {
      if (viaButton) await ctx.answerCallbackQuery({ text: texts.plan.stale });
      return;
    }
    // План создан: сначала сообщение с тем, когда придёт первая порция, потом сама порция.
    const now = new Date();
    const next = screen.kind === 'started' ? await learning.preview(screen.planId, now) : undefined;
    const { text, keyboard } = renderPlan(screen, next);
    if (viaButton) {
      await ctx.answerCallbackQuery();
      await editOrReply(ctx, text, keyboard);
    } else {
      await ctx.reply(text, { reply_markup: keyboard });
    }
    if (screen.kind === 'started' && next?.kind === 'sent') {
      await learning.issueIfDue(screen.planId, now);
    }
  }

  bot.callbackQuery(PLAN_CALLBACK, async (ctx) => {
    const [, token = '', action = '', arg = ''] = ctx.match;
    await showPlan(ctx, await plans.act(ctx.user.id, token, action, arg, new Date()), true);
  });

  // Ответ текстом: диапазон, срок, число единиц в день, дата начала, время.
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();
    const screen = await plans.handleText(ctx.user.id, ctx.message.text, new Date());
    if (!screen) return next();
    await showPlan(ctx, screen, false);
  });

  return {
    async begin(ctx, textId) {
      await showPlan(ctx, await plans.begin(ctx.user.id, textId, new Date()), false);
    },
  };
}
