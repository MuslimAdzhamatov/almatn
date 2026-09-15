# almatn

Telegram-бот для заучивания текстов из любого PDF (например, манзум на арабском с пронумерованными строками) по системе интервального повторения. Порции приходят картинками, вырезанными из PDF, повторы — одним сводным сообщением.

- Полное техзадание: [CLAUDE.md](./CLAUDE.md)
- Пошаговый план разработки: [01_plan.md](./01_plan.md)
- Стартовый промт для Claude Code: [02_start_prompt.md](./02_start_prompt.md)

## Быстрый старт

1. Открой этот репозиторий в Claude Code.
2. Вставь промт из `02_start_prompt.md`.
3. Следуй инструкциям — Claude Code сначала проведёт ревью документации, затем предложит структуру/схему данных и реализует проект по этапам.

## Локальный запуск — зависимости

- Node.js (LTS)
- PostgreSQL — например, [Postgres.app](https://postgresapp.com), база `almatn`
- poppler — `pdftotext`, `pdftoppm` (`brew install poppler`)
- `.env` по образцу `.env.example` (токен **тестового** бота и строка подключения к БД)

```bash
npm install                 # зависимости + генерация Prisma Client
cp .env.example .env        # заполнить BOT_TOKEN и DATABASE_URL
npm run db:migrate          # создать БД (если нет) и применить миграции
npm run dev                 # запустить бота (long polling, перезапуск при изменениях)
```

Прочие команды: `npm test` (юнит-тесты), `npm run typecheck`, `npm run lint`, `npm run format`, `npm run build && npm start` (сборка и запуск из `dist/`), `npm run db:studio` (просмотр БД).

## Деплой

VPS вне РФ, Docker Compose, бэкапы БД и PDF — см. [01_plan.md](./01_plan.md), этап 9. Подробная инструкция появится на этом этапе.
