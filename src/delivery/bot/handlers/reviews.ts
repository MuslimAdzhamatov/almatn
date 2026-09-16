import type { Bot } from 'grammy';
import type { BatchAction, BatchState, Reviews } from '../../../app/reviews.js';
import type { BotContext } from '../context.js';
import { texts } from '../texts.js';
import { learnedMessage, nextPortionText } from '../views/learning.js';
import { batchKeyboard, REVIEW_CALLBACK } from '../views/reviews.js';

const t = texts.reviews;

/** Под сводкой остаются только кнопки, на которые ещё можно ответить, и кнопки контекста. */
async function redraw(ctx: BotContext, state: BatchState) {
  await ctx.editMessageReplyMarkup({ reply_markup: batchKeyboard(state) }).catch(() => undefined);
}

async function show(ctx: BotContext, action: BatchAction) {
  switch (action.kind) {
    case 'stale':
      await ctx.answerCallbackQuery({ text: texts.learn.stale });
      return;
    case 'unchanged':
      await ctx.answerCallbackQuery({
        text: action.portion ? texts.learn.alreadyLearned : t.nothingToAnswer,
      });
      await redraw(ctx, action.state);
      return;
    case 'learned':
      await ctx.answerCallbackQuery();
      await redraw(ctx, action.state);
      await ctx.reply(learnedMessage(action.action));
      return;
    case 'answered': {
      const { state } = action;
      if (action.answer === 'missed') {
        await ctx.answerCallbackQuery({ text: t.missed, show_alert: true });
        await redraw(ctx, state);
        return;
      }
      await ctx.answerCallbackQuery();
      await redraw(ctx, state);
      const lines = [t.confirmed(state.title)];
      if (action.planCompleted) lines.push(t.planCompleted(state.title));
      if (action.next) lines.push(nextPortionText(action.next, state.timezone));
      await ctx.reply(lines.join('\n\n'));
      return;
    }
  }
}

export function registerReviews(bot: Bot<BotContext>, reviews: Reviews) {
  bot.callbackQuery(REVIEW_CALLBACK, async (ctx) => {
    const [, id = '', action = ''] = ctx.match;
    const deliveryId = Number(id);
    const userId = ctx.user.id;
    const now = new Date();
    if (action === 'ok') return show(ctx, await reviews.learned(userId, deliveryId, now));
    const answer = action === 'done' ? 'confirmed' : 'missed';
    return show(ctx, await reviews.answer(userId, deliveryId, answer, now));
  });
}
