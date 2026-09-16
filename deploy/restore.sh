#!/usr/bin/env bash
# Восстановление almatn из бэкапа: ./deploy/restore.sh /var/backups/almatn/2026-09-17_0300
# Каталог бэкапа должен содержать db.dump и data.tar.gz (скачать с rclone: rclone copy remote:путь каталог).
# ВНИМАНИЕ: текущие база и файлы бота будут заменены.
set -euo pipefail

cd "$(dirname "$0")/.."
SOURCE="${1:?укажите каталог бэкапа}"
[[ -f "$SOURCE/db.dump" && -f "$SOURCE/data.tar.gz" ]] || {
  echo "В $SOURCE нет db.dump или data.tar.gz" >&2
  exit 1
}

read -r -p "Заменить текущие базу и файлы данными из $SOURCE? [y/N] " answer
[[ "$answer" == "y" ]] || exit 1

echo "[restore] останавливаю бота"
docker compose stop bot
docker compose up -d db

echo "[restore] база"
docker compose exec -T db pg_restore -U almatn -d almatn --clean --if-exists --no-owner < "$SOURCE/db.dump"

echo "[restore] файлы"
docker compose run --rm --no-deps -T --entrypoint sh bot \
  -c 'find /app/data -mindepth 1 -delete && tar -xzf - -C /app/data' < "$SOURCE/data.tar.gz"

echo "[restore] миграции и запуск"
docker compose up -d
docker compose logs --tail=20 bot
