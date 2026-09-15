import { createOnboarding } from './app/onboarding.js';
import { env } from './config/env.js';
import { createDb } from './db/client.js';
import { createDialogsRepository } from './db/repositories/dialogs.js';
import { createUsersRepository } from './db/repositories/users.js';
import { BOT_COMMANDS, createBot } from './delivery/bot/bot.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  const db = createDb(env.DATABASE_URL);
  await db.$connect();

  const users = createUsersRepository(db);
  const onboarding = createOnboarding({ users, dialogs: createDialogsRepository(db) });

  const bot = createBot(env.BOT_TOKEN, { users, onboarding, logger });
  await bot.api.setMyCommands(BOT_COMMANDS);

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Останавливаюсь…');
    try {
      await bot.stop();
      await db.$disconnect();
      logger.info('Остановлено корректно');
    } catch (err) {
      logger.error({ err }, 'Ошибка при остановке');
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', (signal) => void shutdown(signal));
  process.once('SIGTERM', (signal) => void shutdown(signal));

  await bot.start({
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => logger.info({ username: me.username }, 'Бот запущен (long polling)'),
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Не удалось запустить бота');
  process.exitCode = 1;
});
