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

## Деплой (VPS вне РФ, Docker Compose)

Состав (`docker-compose.yml`):

- `db` — PostgreSQL 17, данные в томе `pgdata`;
- `migrate` — `prisma migrate deploy`, запускается перед ботом при каждом `docker compose up` и завершается;
- `bot` — бот и планировщик в одном процессе (образ `Dockerfile`, Node 24 + poppler), PDF и картинки в томе `botdata`, автоперезапуск `unless-stopped`, логи pino в JSON (ротация Docker: 5 файлов по 20 МБ).

### Первый запуск

На сервере (Ubuntu/Debian) нужны Docker с плагином Compose и git; для копий бэкапов вне VPS — [rclone](https://rclone.org).

```bash
git clone https://github.com/MuslimAdzhamatov/almatn.git /opt/almatn
cd /opt/almatn
cp .env.production.example .env
nano .env                                  # BOT_TOKEN боевого бота, POSTGRES_PASSWORD (openssl rand -hex 24)
docker compose up -d --build               # сборка, миграции, запуск
docker compose ps                          # migrate — exited (0), db и bot — running
docker compose logs -f bot                 # «Бот запущен (long polling)»
```

Боевой бот — **отдельный** токен от @BotFather. Один и тот же токен нельзя запускать в двух местах одновременно (Telegram отвечает 409, одна из копий не получает сообщения) — тестовый бот остаётся для `npm run dev`.

### Обновление

```bash
cd /opt/almatn
git pull
docker compose up -d --build               # новые миграции применятся до старта бота
docker compose logs --tail=50 bot
```

При остановке бот дожидается текущего тика планировщика (до 2 минут); расписание хранится в БД, поэтому после перезапуска ничего не теряется и не дублируется.

### Бэкапы

`deploy/backup.sh` делает дамп базы (`db.dump`, формат `pg_dump -Fc`) и архив файлов (`data.tar.gz`, без кэша отрендеренных страниц — он восстанавливается сам), проверяет их, копирует вне VPS через rclone и удаляет локальные копии старше `BACKUP_KEEP_DAYS` дней. Настройки — в `.env` (`BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `RCLONE_REMOTE`).

```bash
rclone config                              # один раз: хранилище вне VPS (S3, Backblaze B2, Google Drive…)
echo 'RCLONE_REMOTE=offsite:almatn' >> .env
./deploy/backup.sh                         # проверить вручную
crontab -e                                 # ежедневно в 03:30 UTC:
# 30 3 * * * cd /opt/almatn && ./deploy/backup.sh >> /var/log/almatn-backup.log 2>&1
```

Без `RCLONE_REMOTE` скрипт предупреждает, что копия есть только на этом VPS — это не защищает от потери сервера. Раз в месяц стоит проверять восстановление на отдельной машине.

### Восстановление

```bash
cd /opt/almatn                             # на новом сервере — сначала шаги «Первого запуска»
rclone copy offsite:almatn/2026-09-17_0330 /var/backups/almatn/2026-09-17_0330
./deploy/restore.sh /var/backups/almatn/2026-09-17_0330
```

Скрипт останавливает бота, заменяет базу (`pg_restore --clean`) и файлы, затем запускает всё заново (миграции применятся, если бэкап старше кода).

### Полезное

```bash
docker compose exec db psql -U almatn almatn    # консоль базы
docker compose restart bot                      # перезапуск бота
docker compose down                             # остановка (тома с данными сохраняются)
```
