import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { Learning } from '../../app/learning.js';
import type { Onboarding } from '../../app/onboarding.js';
import type { Pause } from '../../app/pause.js';
import type { Plans } from '../../app/plans.js';
import type { Reviews } from '../../app/reviews.js';
import type { Settings } from '../../app/settings.js';
import type { FileStore } from '../../app/ports.js';
import type { Texts } from '../../app/texts.js';
import type { UsersRepository } from '../../db/repositories/users.js';
import type { Logger } from '../../lib/logger.js';
import type { BotContext } from './context.js';
import { registerLearning } from './handlers/learning.js';
import { registerOnboarding } from './handlers/onboarding.js';
import { registerPace } from './handlers/pace.js';
import { registerPause } from './handlers/pause.js';
import { registerPlans, type PlansHandlers } from './handlers/plans.js';
import { registerReviews } from './handlers/reviews.js';
import { registerSettings } from './handlers/settings.js';
import { registerTexts } from './handlers/texts.js';
import { texts } from './texts.js';

export interface BotDeps {
  users: UsersRepository;
  onboarding: Onboarding;
  texts: Texts;
  plans: Plans;
  learning: Learning;
  reviews: Reviews;
  pause: Pause;
  settings: Settings;
  files: FileStore;
  logger: Logger;
}

export const BOT_COMMANDS: BotCommand[] = Object.entries(texts.commands).map(
  ([command, description]) => ({ command, description }),
);

export function createBot(token: string, deps: BotDeps): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  // Любое обращение пользователя создаёт/обновляет его в БД (lastActivityAt нужен для автопаузы).
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    const user = await deps.users.touch(
      { id: ctx.from.id, username: ctx.from.username },
      new Date(),
    );
    ctx.user = { id: user.id, onboarded: user.onboardedAt !== null };
    await next();
  });

  // Обработчики текстов регистрируются первыми: файл, присланный до конца настройки,
  // должен попасть в копилку, а не в шаг онбординга. Текстовые сообщения они пропускают дальше.
  // Создание плана начинается сразу после сохранения текста; его ответы текстом — после онбординга.
  let plansHandlers: PlansHandlers | null = null;
  const textsHandlers = registerTexts(bot, {
    texts: deps.texts,
    files: deps.files,
    token,
    logger: deps.logger,
    onSaved: (ctx, textId) => plansHandlers?.begin(ctx, textId) ?? Promise.resolve(),
  });
  registerOnboarding(bot, deps.onboarding, { onFinished: textsHandlers.processPending });
  plansHandlers = registerPlans(bot, deps.plans, deps.learning);
  registerLearning(bot, deps.learning);
  registerReviews(bot, deps.reviews);
  registerPause(bot, deps.pause);
  registerPace(bot, deps.learning);
  registerSettings(bot, deps.settings);

  bot.command(['today', 'progress', 'texts', 'help'], async (ctx) => {
    await ctx.reply(texts.notReadyYet);
  });

  bot.on('message', async (ctx) => {
    await ctx.reply(texts.unknownMessage);
  });

  bot.catch(async (err) => {
    const { ctx, error } = err;
    const meta = { err: error, updateId: ctx.update.update_id };
    if (error instanceof GrammyError) deps.logger.error(meta, 'Ошибка Telegram API');
    else if (error instanceof HttpError) deps.logger.error(meta, 'Сетевая ошибка Telegram');
    else deps.logger.error(meta, 'Ошибка обработки апдейта');
    await ctx.reply(texts.unexpectedError).catch(() => undefined);
  });

  return bot;
}
