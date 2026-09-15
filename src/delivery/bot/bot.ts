import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { UsersRepository } from '../../db/repositories/users.js';
import type { Logger } from '../../lib/logger.js';
import { texts } from './texts.js';

export interface BotDeps {
  users: UsersRepository;
  logger: Logger;
}

export const BOT_COMMANDS: BotCommand[] = Object.entries(texts.commands).map(
  ([command, description]) => ({ command, description }),
);

export function createBot(token: string, deps: BotDeps): Bot {
  const bot = new Bot(token);

  bot.api.config.use(apiThrottler());
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));

  // Любое обращение пользователя обновляет lastActivityAt (нужно для автопаузы).
  bot.use(async (ctx, next) => {
    if (ctx.from && !ctx.from.is_bot) {
      await deps.users.touch({ id: ctx.from.id, username: ctx.from.username }, new Date());
    }
    await next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(texts.start.welcome(ctx.from?.first_name));
  });

  bot.command(['today', 'progress', 'texts', 'pause', 'settings', 'help'], async (ctx) => {
    await ctx.reply(texts.notReadyYet);
  });

  bot.catch(async (err) => {
    const { ctx, error } = err;
    if (error instanceof GrammyError) {
      deps.logger.error({ err: error, updateId: ctx.update.update_id }, 'Ошибка Telegram API');
    } else if (error instanceof HttpError) {
      deps.logger.error({ err: error, updateId: ctx.update.update_id }, 'Сетевая ошибка Telegram');
    } else {
      deps.logger.error({ err: error, updateId: ctx.update.update_id }, 'Ошибка обработки апдейта');
    }
    await ctx.reply(texts.unexpectedError).catch(() => undefined);
  });

  return bot;
}
