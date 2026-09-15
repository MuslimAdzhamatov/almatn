import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { Onboarding } from '../../app/onboarding.js';
import type { UsersRepository } from '../../db/repositories/users.js';
import type { Logger } from '../../lib/logger.js';
import type { BotContext } from './context.js';
import { registerOnboarding } from './handlers/onboarding.js';
import { texts } from './texts.js';

export interface BotDeps {
  users: UsersRepository;
  onboarding: Onboarding;
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

  registerOnboarding(bot, deps.onboarding);

  bot.command(['today', 'progress', 'texts', 'pause', 'settings', 'help'], async (ctx) => {
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
