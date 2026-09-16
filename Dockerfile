# almatn — бот и планировщик в одном процессе (CLAUDE.md, раздел 6, этап 9).

# ——— Сборка: зависимости, Prisma Client, TypeScript → dist/ ———
FROM node:24-bookworm-slim AS build
# openssl нужен движку миграций Prisma.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# prisma.config.ts читает DATABASE_URL; для генерации клиента подойдёт любая строка.
ENV DATABASE_URL=postgresql://build@localhost/build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall: prisma generate и загрузка движка миграций.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ——— Миграции: prisma migrate deploy перед запуском бота (сервис migrate в compose) ———
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# ——— Запуск: только production-зависимости, poppler и шрифты для рендера PDF ———
# Клиент Prisma уже собран в dist/generated и работает без нативного движка (wasm).
FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils poppler-data fonts-dejavu-core fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/app/data
COPY package.json package-lock.json ./
# sharp ставит готовые бинарники через optionalDependencies — скрипты установки не нужны.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
CMD ["node", "dist/main.js"]
