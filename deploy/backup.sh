#!/usr/bin/env bash
# Ежедневный бэкап almatn: дамп PostgreSQL и архив каталога с PDF и картинками (том botdata).
# Запуск из каталога проекта на сервере (cron — см. README): ./deploy/backup.sh
# Копия уходит вне VPS через rclone, если задан RCLONE_REMOTE.
set -euo pipefail

cd "$(dirname "$0")/.."
# Переменные бэкапа из .env (BACKUP_DIR, BACKUP_KEEP_DAYS, RCLONE_REMOTE).
if [[ -f .env ]]; then
  eval "$(grep -E '^(BACKUP_DIR|BACKUP_KEEP_DAYS|RCLONE_REMOTE)=' .env || true)"
fi
BACKUP_DIR="${BACKUP_DIR:-/var/backups/almatn}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%d_%H%M)"
TARGET="$BACKUP_DIR/$STAMP"
mkdir -p "$TARGET"

echo "[backup] база → $TARGET/db.dump"
docker compose exec -T db pg_dump -U almatn -d almatn -Fc > "$TARGET/db.dump"

echo "[backup] файлы → $TARGET/data.tar.gz"
# Кэш отрендеренных страниц восстанавливается сам — в архив не берём.
docker compose run --rm --no-deps -T --entrypoint tar bot \
  -czf - -C /app/data --exclude='./texts/*/pages' --exclude='./tmp' . > "$TARGET/data.tar.gz"

# Проверка: дамп читается, архив не битый.
docker compose exec -T db pg_restore --list < "$TARGET/db.dump" > /dev/null
gzip -t "$TARGET/data.tar.gz"
echo "[backup] готово: $(du -sh "$TARGET" | cut -f1)"

if [[ -n "${RCLONE_REMOTE:-}" ]]; then
  echo "[backup] копия вне VPS → $RCLONE_REMOTE/$STAMP"
  rclone copy "$TARGET" "$RCLONE_REMOTE/$STAMP"
else
  echo "[backup] ВНИМАНИЕ: RCLONE_REMOTE не задан — копия есть только на этом VPS" >&2
fi

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$BACKUP_KEEP_DAYS" -exec rm -rf {} +
