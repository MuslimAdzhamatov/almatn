// Пороги и лимиты (CLAUDE.md, разделы 4.1 и 5.7) — в одном месте, а не в обработчиках.

const MB = 1024 * 1024;

export const limits = {
  pdf: {
    /** Bot API не скачивает файлы больше 20 МБ. */
    maxBytes: 20 * MB,
    maxPages: 500,
    /** Сколько страниц рендерить за один вызов pdftoppm при анализе — чтобы большие книги не упирались в таймаут. */
    renderChunkPages: 50,
    /** Разрешение для анализа строк (профиль пикселей). */
    analysisDpi: 100,
    /** Разрешение картинок, которые получает пользователь. */
    cropDpi: 200,
    /** Сколько первых строк показать в сводке после разбора. */
    previewLines: 5,
    /** Telegram отклоняет фото с соотношением сторон больше 20:1. */
    maxImageAspect: 20,
  },
  texts: {
    maxPerUser: 10,
    maxTitleLength: 100,
  },
} as const;

export const BYTES_IN_MB = MB;
