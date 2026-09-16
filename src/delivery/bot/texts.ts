// Все тексты интерфейса бота — в одном месте (CLAUDE.md, раздел 5.5).

import type { DailySchedule, ScheduleEntry } from '../../core/time/schedule.js';
import { formatOffset, type ZoneGroup, type ZoneNow } from '../../core/time/zones.js';

const localTime = (zone: ZoneNow) => zone.local.toFormat('HH:mm');

const zoneName = (zone: ZoneNow) =>
  zone.city
    ? `${zone.city} (UTC${formatOffset(zone.offsetMinutes)})`
    : `UTC${formatOffset(zone.offsetMinutes)}`;

function entryText(entry: ScheduleEntry): string {
  if (!entry.atNight) return `в ${entry.planned}`;
  return entry.actual === entry.planned
    ? `в ${entry.planned} (ночью)`
    : `в ${entry.planned} → придёт в ${entry.actual}`;
}

function scheduleText(schedule: DailySchedule): string {
  return [
    'Расписание:',
    `• новая порция — ${entryText(schedule.newPortion)}`,
    `• повтор через 12 часов — ${entryText(schedule.secondSlot)}`,
    `• остальные повторы — ${entryText(schedule.newPortion)}`,
    `• напоминание о невыполненном — ${entryText(schedule.eveningReminder)}`,
  ].join('\n');
}

export const texts = {
  commands: {
    start: 'Начало работы',
    today: 'Что на сегодня',
    progress: 'Прогресс по текстам',
    texts: 'Мои тексты',
    pause: 'Пауза / продолжить',
    settings: 'Настройки',
    help: 'Как пользоваться ботом',
  },

  onboarding: {
    welcome: (firstName: string | undefined) =>
      [
        `Здравствуйте${firstName ? `, ${firstName}` : ''}!`,
        '',
        'Я almatn — помогу выучить текст из PDF: буду присылать порции по расписанию и напоминать о повторениях (через 12 часов, день, 3 дня, 2 недели и месяц).',
        '',
        'Сначала настроим расписание.',
      ].join('\n'),

    chooseTimezone: (group: ZoneGroup) =>
      group === 'utc'
        ? 'Выберите смещение от UTC — на кнопке текущее время в этом поясе.'
        : 'Выберите ваш часовой пояс. Рядом с городом — смещение от UTC.',

    groups: {
      russia: '🇷🇺 Россия',
      world: '🌍 СНГ и другие страны',
      utc: '🕐 Нет моего города',
    } satisfies Record<ZoneGroup, string>,

    zoneButton: (zone: ZoneNow) =>
      zone.city
        ? `${zone.city} ${formatOffset(zone.offsetMinutes)}`
        : `UTC${formatOffset(zone.offsetMinutes)} · ${localTime(zone)}`,

    confirmTimezone: (zone: ZoneNow) =>
      [
        `Часовой пояс: ${zoneName(zone)}.`,
        `Сейчас у вас ${localTime(zone)}, ${zone.local.setLocale('ru').toFormat('cccc, d MMMM')}.`,
        '',
        'Всё верно?',
      ].join('\n'),
    confirmYes: 'Да, верно',
    confirmNo: 'Выбрать другой',

    chooseSendTime: (zone: ZoneNow, invalid: boolean) =>
      [
        ...(invalid
          ? ['Не получилось разобрать время. Напишите в формате ЧЧ:ММ, например 06:30.', '']
          : []),
        `Часовой пояс: ${zoneName(zone)}.`,
        '',
        'В какое время присылать новую порцию? Выберите кнопку или напишите своё время в формате ЧЧ:ММ, например 06:30.',
      ].join('\n'),

    chooseNightPolicy: (schedule: DailySchedule, nightStart: string, nightEnd: string) =>
      [
        scheduleText(schedule),
        '',
        `Часть сообщений попадает на ночь (тихие часы ${nightStart}–${nightEnd}). Как с ними поступать?`,
      ].join('\n'),
    nightKeep: 'Оставить по часам',
    nightMove: (nightEnd: string) => `Переносить на ${nightEnd}`,
    nightOther: 'Другое время утра',

    chooseNightEnd: (
      nightStart: string,
      error: 'invalid_time' | 'equals_night_start' | undefined,
    ) =>
      error === 'equals_night_start'
        ? `Это время совпадает с началом тихих часов (${nightStart}). Напишите другое время.`
        : [
            ...(error === 'invalid_time' ? ['Не получилось разобрать время.', ''] : []),
            'Во сколько присылать сообщения, которые попали на ночь? Напишите время в формате ЧЧ:ММ, например 08:00.',
          ].join('\n'),

    done: (zone: ZoneNow, schedule: DailySchedule) =>
      [
        'Готово, расписание сохранено ✅',
        '',
        `Часовой пояс: ${zoneName(zone)}.`,
        scheduleText(schedule),
        '',
        'Изменить это можно будет в /settings. Следующий шаг — загрузка PDF с текстом (появится в ближайшем обновлении).',
      ].join('\n'),

    summary: (zone: ZoneNow, schedule: DailySchedule) =>
      [
        'С возвращением!',
        '',
        `Часовой пояс: ${zoneName(zone)}.`,
        scheduleText(schedule),
        '',
        'Загрузка PDF появится в ближайшем обновлении.',
      ].join('\n'),

    staleButton: 'Эта кнопка уже неактуальна',
    useButtons: 'Выберите вариант кнопкой ниже 👇',
    finishFirst: 'Сначала закончим настройку расписания.',
  },

  upload: {
    unsupported:
      'Пришлите текст в формате PDF (файлом) или картинки страниц — JPG или PNG. Другие форматы бот не читает.',
    photoAdvice:
      'Совет: присылайте картинки файлом, а не фото — Telegram сильно сжимает фото, и харакаты могут размыться.',
    imageCollected: (pages: number, limit: number) =>
      pages >= limit
        ? `Страниц: ${pages} — это максимум. Нажмите «Готово», чтобы разобрать текст.`
        : `Страниц собрано: ${pages}. Пришлите следующие или нажмите «Готово».`,
    imagesTooMany: (limit: number) =>
      `Больше ${limit} картинок в один текст не поместится. Нажмите «Готово» или «Отмена».`,
    imagesEmpty: 'Пока не прислано ни одной картинки.',
    imagesCancelled: 'Загрузка картинок отменена.',
    imagesBusy: 'Сначала закончите с картинками: нажмите «Готово» или «Отмена».',
    savedUntilOnboarded: 'Файл сохранён ✅ Вернусь к нему, как только закончим настройку.',
    backToPendingFile: 'Возвращаюсь к вашему файлу.',
    tooBig: (limitMb: number) =>
      `Файл больше ${limitMb} МБ — Telegram не даёт ботам скачивать такие файлы. Сожмите PDF или разделите его на части.`,
    tooManyTexts: (limit: number) =>
      `У вас уже ${limit} текстов — это максимум. Удалите ненужный текст, чтобы загрузить новый.`,
    downloading: 'Получаю файл…',
    downloadFailed: 'Не удалось скачать файл из Telegram. Попробуйте отправить его ещё раз.',
    accepted: (queued: number) =>
      queued > 1
        ? `Файл получен ✅ Разберу его, как только освобожусь (перед вами в очереди: ${queued - 1}).`
        : 'Файл получен ✅ Разбираю — обычно это занимает до минуты.',
    duplicate: (title: string) => `Этот файл уже загружен — текст «${title}».`,
    pendingQuestion: (title: string) =>
      `У вас есть неподтверждённый текст «${title}». Что сделать?`,
    pendingResumed: (title: string) => `Продолжаем с «${title}» — сводка ниже.`,
    pendingReplaced: (title: string | null) =>
      title ? `Текст «${title}» удалён. Загружаю новый файл.` : 'Загружаю новый файл.',
    password: 'PDF защищён паролем. Сохраните его без пароля и пришлите снова.',
    damaged: 'Не получается прочитать этот PDF: похоже, файл повреждён.',
    empty: 'В этом PDF нет ни одной страницы.',
    tooManyPages: (pages: number, limit: number) =>
      `В PDF ${pages} страниц, а бот принимает до ${limit}. Пришлите только нужную часть текста.`,
    parseFailed: (fileName: string) =>
      `Не удалось разобрать «${fileName}». Попробуйте другой файл.`,

    summaryTitle: (title: string, fileName: string) => `📄 «${title}» — ${fileName}`,
    found: (count: string, firstPage: number, lastPage: number, pageCount: number) =>
      `Найдено: ${count} на страницах ${firstPage}–${lastPage} (всего страниц в файле: ${pageCount}).`,
    byNumbers: 'Способ разбора: по номерам строк.',
    byTextLines:
      'Способ разбора: по строкам текста — номеров в файле нет, поэтому строки пронумерованы по порядку.',
    byParagraphs:
      'Способ разбора: по абзацам — номеров в файле нет, поэтому абзацы пронумерованы по порядку. Сноски и колонтитулы в них не входят.',
    byImageLines:
      'Способ разбора: по изображению страниц — это скан, текста в файле нет. Строки найдены по расположению на странице и пронумерованы по порядку.',
    byPages: (count: string) => `Способ разбора: постранично — ${count}.`,
    noTextLayerFallback: (count: string) =>
      `В этом PDF не удалось найти ни номеров строк, ни строк текста, ни строк на изображении страниц. Единица заучивания — страница целиком (${count}).`,
    anomaliesTitle: 'Исправления нумерации:',
    anomaly: (anomaly: NumberingAnomaly) => {
      switch (anomaly.kind) {
        case 'misprint':
          return `стр. ${anomaly.page}: номер напечатан как ${anomaly.printed}, по порядку это ${anomaly.lineNumber}`;
        case 'missing_number':
          return `стр. ${anomaly.page}: у строки ${anomaly.lineNumber} не найден номер — строка определена по положению`;
        case 'skipped_number':
          return `стр. ${anomaly.page}: после строки ${anomaly.afterLine} в нумерации пропущено ${anomaly.skipped.join(', ')} — строки пронумерованы по порядку`;
      }
    },
    moreAnomalies: (count: number) => `…и ещё ${count}`,
    previewLines:
      'Ниже — первые строки так, как их будет присылать бот. Проверьте, что строки вырезаны правильно.',
    previewPage: 'Ниже — первая страница так, как её будет присылать бот.',
    confirmPrompt: 'Всё разобрано верно?',

    buttons: {
      confirm: '✅ Всё верно',
      callAs: (unit: UnitName) => `Называть «${RANGE_LABELS[unit].toLowerCase()}»`,
      byPages: '📄 Разобрать постранично',
      byNumbers: '🔢 Разобрать по номерам строк',
      cancel: 'Отмена',
      keepTitle: (title: string) => `Оставить «${shorten(title, 32)}»`,
      resumePending: (title: string) => `Продолжить с «${shorten(title, 32)}»`,
      replacePending: 'Удалить и загрузить новый',
      imagesDone: (pages: number) => `✅ Готово, это все страницы (${pages})`,
      imagesCancel: 'Отмена',
    },
    unitChanged: (unit: UnitName) => `Теперь — «${RANGE_LABELS[unit].toLowerCase()}»`,
    askTitle: (title: string) => `Как назвать текст? Напишите название или оставьте «${title}».`,
    invalidTitle: (maxLength: number) =>
      `Название должно быть от 1 до ${maxLength} символов. Напишите другое.`,
    saved: (title: string, count: string) =>
      `Текст «${title}» сохранён: ${count} ✅\n\nСоздание плана заучивания появится в ближайшем обновлении.`,
    reparsing: 'Разбираю заново…',
    cancelled: 'Загрузка отменена, файл удалён.',
    stale: 'Эта кнопка уже неактуальна',
    staleTitle: 'Этот текст уже сохранён или удалён.',
  },

  notReadyYet: 'Эта функция появится на следующих этапах разработки.',
  unknownMessage: 'Не понял сообщение. Список команд — в меню бота.',
  unexpectedError: 'Что-то пошло не так. Попробуйте ещё раз чуть позже.',
} as const;

type NumberingAnomaly = import('../../core/pdf/numbers.js').NumberingAnomaly;
type ParseStrategy = import('../../app/ports.js').ParseStrategy;
type UnitName = import('../../app/ports.js').UnitName;

const NOUNS = {
  lines: ['строка', 'строки', 'строк'],
  bayts: ['бейт', 'бейта', 'бейтов'],
  hadiths: ['хадис', 'хадиса', 'хадисов'],
  paragraphs: ['абзац', 'абзаца', 'абзацев'],
  pages: ['страница', 'страницы', 'страниц'],
} as const;
const RANGE_LABELS = {
  lines: 'Строки',
  bayts: 'Бейты',
  hadiths: 'Хадисы',
  paragraphs: 'Абзацы',
  pages: 'Страницы',
} as const;
const SINGLE_LABELS = {
  lines: 'Строка',
  bayts: 'Бейт',
  hadiths: 'Хадис',
  paragraphs: 'Абзац',
  pages: 'Страница',
} as const;

/** Постраничный разбор — единица «страница», иначе — как выбрал пользователь. */
const unitKind = (strategy: ParseStrategy, unitName: UnitName) =>
  strategy === 'manual_page' ? 'pages' : unitName;

export function pluralRu(n: number, [one, few, many]: readonly [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «448 бейтов», «1 страница». */
export function unitCount(n: number, strategy: ParseStrategy, unitName: UnitName): string {
  return `${n} ${pluralRu(n, NOUNS[unitKind(strategy, unitName)])}`;
}

/** Подпись к картинке: «Бейты 41–45», «Страница 3». */
export function unitRangeLabel(
  start: number,
  end: number,
  strategy: ParseStrategy,
  unitName: UnitName,
): string {
  const kind = unitKind(strategy, unitName);
  return start === end
    ? `${SINGLE_LABELS[kind]} ${start}`
    : `${RANGE_LABELS[kind]} ${start}–${end}`;
}

function shorten(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
