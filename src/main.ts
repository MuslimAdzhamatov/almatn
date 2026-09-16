import type { Bot } from 'grammy';
import cron from 'node-cron';
import { createImages } from './app/images.js';
import { createLearning } from './app/learning.js';
import { createOnboarding } from './app/onboarding.js';
import { createPlans } from './app/plans.js';
import type { PdfTools } from './app/ports.js';
import { createTexts } from './app/texts.js';
import { env } from './config/env.js';
import { limits } from './config/limits.js';
import { extractWords, pdfInfo, renderPage, renderPages } from './core/pdf/poppler.js';
import { cropPng, imageSize, loadGray } from './core/pdf/render.js';
import { createDb } from './db/client.js';
import { createDialogsRepository } from './db/repositories/dialogs.js';
import { createCropCacheRepository, createLearningRepository } from './db/repositories/learning.js';
import { createPlansRepository } from './db/repositories/plans.js';
import { createTextsRepository } from './db/repositories/texts.js';
import { createUploadsRepository } from './db/repositories/uploads.js';
import { createUsersRepository } from './db/repositories/users.js';
import { BOT_COMMANDS, createBot } from './delivery/bot/bot.js';
import { createNotifier } from './delivery/bot/notifier.js';
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
  const textsStore = createTextsRepository(db);
  const texts = createTexts({
    store: textsStore,
    uploads: createUploadsRepository(db),
    dialogs,
    files,
    tools: pdfTools,
    reportError: (err, context) => logger.error({ err, ...context }, 'Ошибка обработки текста'),
  });
  const plans = createPlans({
    plans: createPlansRepository(db),
    texts: textsStore,
    users,
    dialogs,
    limits: limits.plan,
  });

  // Notifier получает api лениво: бот создаётся ниже, а сценариям Notifier нужен уже сейчас.
  let botApi: Bot['api'] | null = null;
  const learning = createLearning({
    store: createLearningRepository(db),
    notifier: createNotifier(() => {
      if (!botApi) throw new Error('Бот ещё не создан');
      return botApi;
    }),
    images: createImages({ files, tools: pdfTools, cache: createCropCacheRepository(db) }),
    reportError: (err, context) => logger.error({ err, ...context }, 'Ошибка выдачи порции'),
  });

  // До приёма сообщений: загрузок и разборов ещё нет, всё во tmp/ и work-* — остатки прошлого запуска.
  const stale = await files.cleanupStale();
  if (stale.tmpFiles > 0 || stale.workDirs > 0) {
    logger.info(stale, 'Удалены временные файлы прошлого запуска');
  }

  const bot = createBot(env.BOT_TOKEN, {
    users,
    onboarding,
    texts,
    plans,
    learning,
    files,
    logger,
  });
  botApi = bot.api;
  await bot.api.setMyCommands(BOT_COMMANDS);
  // Разборы PDF, прерванные перезапуском, продолжаются (статус хранится в БД).
  await texts.resumeParsing();

  // Планировщик (CLAUDE.md, раздел 5.6): раз в минуту, всё расписание — в БД.
  let currentTick: Promise<void> | null = null;
  const runTick = () => {
    if (currentTick) return;
    currentTick = learning
      .tick(new Date())
      .then((ran) => {
        if (!ran) logger.debug('Тик пропущен: его выполняет другой экземпляр');
      })
      .catch((err: unknown) => logger.error({ err }, 'Ошибка тика планировщика'))
      .finally(() => {
        currentTick = null;
      });
  };
  const scheduler = cron.schedule('* * * * *', runTick, { name: 'tick', noOverlap: true });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Останавливаюсь…');
    try {
      await scheduler.stop();
      await currentTick;
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
    onStart: (me) => {
      logger.info({ username: me.username }, 'Бот запущен (long polling)');
      // Догон после простоя: всё, что созрело, пока бот был выключен.
      runTick();
    },
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Не удалось запустить бота');
  process.exitCode = 1;
});
