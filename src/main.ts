import { createOnboarding } from './app/onboarding.js';
import type { PdfTools } from './app/ports.js';
import { createTexts } from './app/texts.js';
import { env } from './config/env.js';
import { extractWords, pdfInfo, renderPage, renderPages } from './core/pdf/poppler.js';
import { cropPng, imageSize, loadGray } from './core/pdf/render.js';
import { createDb } from './db/client.js';
import { createDialogsRepository } from './db/repositories/dialogs.js';
import { createTextsRepository } from './db/repositories/texts.js';
import { createUsersRepository } from './db/repositories/users.js';
import { BOT_COMMANDS, createBot } from './delivery/bot/bot.js';
import { logger } from './lib/logger.js';
import { createFileStorage } from './storage/files.js';

async function main(): Promise<void> {
  const db = createDb(env.DATABASE_URL);
  await db.$connect();

  const users = createUsersRepository(db);
  const dialogs = createDialogsRepository(db);
  const files = createFileStorage(env.DATA_DIR);
  const pdfTools: PdfTools = {
    info: pdfInfo,
    words: extractWords,
    render: renderPages,
    renderPage,
    loadGray,
    imageSize,
    crop: (path, rect) => cropPng(path, rect),
  };

  const onboarding = createOnboarding({ users, dialogs });
  const texts = createTexts({
    store: createTextsRepository(db),
    dialogs,
    files,
    tools: pdfTools,
    reportError: (err, context) => logger.error({ err, ...context }, 'Ошибка обработки текста'),
  });

  // До приёма сообщений: загрузок и разборов ещё нет, всё во tmp/ и work-* — остатки прошлого запуска.
  const stale = await files.cleanupStale();
  if (stale.tmpFiles > 0 || stale.workDirs > 0) {
    logger.info(stale, 'Удалены временные файлы прошлого запуска');
  }

  const bot = createBot(env.BOT_TOKEN, { users, onboarding, texts, files, logger });
  await bot.api.setMyCommands(BOT_COMMANDS);
  // Разборы PDF, прерванные перезапуском, продолжаются (статус хранится в БД).
  await texts.resumeParsing();

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
