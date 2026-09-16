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

export function scheduleText(schedule: DailySchedule): string {
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
        'Изменить это можно будет в /settings. Теперь пришлите PDF или картинки страниц с текстом, который хотите выучить.',
      ].join('\n'),

    summary: (zone: ZoneNow, schedule: DailySchedule) =>
      [
        'С возвращением!',
        '',
        `Часовой пояс: ${zoneName(zone)}.`,
        scheduleText(schedule),
        '',
        'Чтобы добавить текст, пришлите PDF или картинки страниц.',
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

    reparseMenu: (firstPage: number, lastPage: number, pageCount: number) =>
      [
        `Сейчас разобраны страницы ${firstPage}–${lastPage} из ${pageCount}.`,
        '',
        'Как разобрать текст?',
      ].join('\n'),
    askPageRange: (pageCount: number) =>
      `Какие страницы разбирать? Напишите диапазон, например 3-${pageCount}, или одно число — с него до конца.`,
    invalidPageRange: (pageCount: number) =>
      `Не понял диапазон. Напишите два числа через дефис в пределах 1–${pageCount}, например 3-${pageCount}.`,
    askLinesPerPage: (max: number) =>
      `Сколько строк резать со страницы? Напишите число от 1 до ${max} — страница поделится на равные полосы.`,
    invalidLinesPerPage: (max: number) => `Напишите число от 1 до ${max}.`,

    buttons: {
      confirm: '✅ Всё верно',
      reparse: '⚙️ Разобрать по-другому',
      strategy: {
        numbers: '🔢 По номерам строк',
        text_lines: '📝 По строкам текста',
        image_lines: '🖼 По строкам на картинке',
        paragraphs: '¶ По абзацам',
        manual_page: '📄 Постранично',
        manual_split: '✂️ N строк со страницы…',
      },
      pageRange: '📑 Выбрать страницы…',
      back: '← Назад',
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
    saved: (title: string, count: string) => `Текст «${title}» сохранён: ${count} ✅`,
    reparsing: 'Разбираю заново…',
    cancelled: 'Загрузка отменена, файл удалён.',
    stale: 'Эта кнопка уже неактуальна',
    staleTitle: 'Этот текст уже сохранён или удалён.',
  },

  plan: {
    scope: (title: string) => `Составим план заучивания «${title}».\n\nЧто учить?`,
    scopeInput: (total: string, invalid: boolean) =>
      [
        ...(invalid ? ['Не получилось разобрать диапазон.', ''] : []),
        `Напишите диапазон, например 1-100 (всего ${total}). Одно число — с него до конца.`,
      ].join('\n'),
    pace: (total: string) => `К заучиванию: ${total}.\n\nКак задать темп?`,
    deadlineKind: 'За какой срок выучить?',
    deadlineDays: (maxDays: number) =>
      `Сколько дней на заучивание? Выберите или напишите число (до ${maxDays}).`,
    deadlineMonths: 'Сколько месяцев на заучивание? Месяц считается за 30 дней.',
    deadlineDate: (start: string) =>
      `К какой дате выучить? Начало — ${start}. Выберите или напишите дату в формате ДД.ММ.ГГГГ.`,
    deadlineErrors: {
      format: 'Не получилось разобрать ответ.',
      too_long: (maxDays: number) => `Слишком долгий срок — не больше ${maxDays} дней.`,
      deadline_before_start: (start: string) => `Срок раньше даты начала (${start}).`,
      no_working_days:
        'В этот срок нет ни одного рабочего дня — все дни выходные. Укажите срок побольше или измените выходные.',
    },
    perDay: (manyNoun: string, max: number, invalid: boolean) =>
      [
        ...(invalid ? [`Нужно целое число от 1 до ${max}.`, ''] : []),
        `Сколько учить в день? Обычно по силам 2–5 ${manyNoun} в день.`,
        'Выберите или напишите своё число.',
      ].join('\n'),
    restDays:
      'Выберите выходные — до двух дней в неделю.\n\nВ выходной не придёт новая порция; повторы и напоминания о них будут как обычно.',
    startDate: (today: string, maxDays: number, invalid: boolean) =>
      [
        ...(invalid
          ? [`Нужна дата не раньше сегодняшней и не позже чем через ${maxDays} дней.`, '']
          : []),
        `С какого дня начать? Сегодня — ${today}. Выберите или напишите дату в формате ДД.ММ.ГГГГ.`,
      ].join('\n'),
    sendTime: (invalid: boolean) =>
      [
        ...(invalid ? ['Не получилось разобрать время.', ''] : []),
        'Во сколько присылать новую порцию? Время общее для всех текстов.',
        'Выберите или напишите время в формате ЧЧ:ММ, например 06:30.',
      ].join('\n'),
    overload: (perDay: string, peak: string) =>
      `⚠️ Это может оказаться тяжело: каждый день ${perDay} и до ${peak} повтора.\n\nРекомендуем 2–5 в день.`,

    confirmTitle: (title: string, range: string, total: string) =>
      `План: «${title}», ${range} (${total}).`,
    pacePerDay: (perDay: string) => `Темп: ${perDay} в день.`,
    paceDeadline: (perDay: string, deadline: string) =>
      `Темп: ${perDay} в день, чтобы выучить к ${deadline}.`,
    restNone: 'Выходные: нет.',
    restList: (days: string) => `Выходные: ${days}.`,
    start: (date: string, isToday: boolean) => `Начало: ${isToday ? `сегодня, ${date}` : date}.`,
    firstPortion: (date: string) => `Первая порция — ${date} (дата начала выпадает на выходной).`,
    endDates: (end: string, lastReview: string) =>
      `Заучивание закончится ${end}, последние повторы — ${lastReview}.`,
    endsEarlyShort: 'Текст короче срока: по одной единице в день он закончится раньше.',
    endsEarlyRounded: 'Норма округлена вверх, поэтому заучивание закончится немного раньше срока.',
    load: (typical: string, peak: number) =>
      `Повторение: обычно ${typical} в день, на пике до ${peak}.`,
    overlap: (titles: string, total: number, peak: number, combined: number) =>
      [
        `⚠️ Уже идут планы: ${titles}.`,
        total > 0
          ? `В ближайшие 2 недели по ним ${total} ${pluralRu(total, ['единица', 'единицы', 'единиц'])} повтора (до ${peak} в день); вместе с новым планом — до ${combined} в день.`
          : `Вместе с новым планом повторение на пике — до ${combined} в день.`,
      ].join('\n'),
    started: (title: string, next: string) => `План «${title}» создан ✅\n\n${next}`,
    firstNow: 'Первая порция — прямо сейчас 👇',
    firstAt: (when: string) => `Первая порция придёт ${when}.`,
    firstPaused: 'Бот на паузе — первая порция придёт после её окончания.',
    firstRetry: 'Первую порцию пришлю через минуту-другую.',
    postponed: 'Хорошо, план можно будет составить позже.',
    alreadyPlanned: (title: string) => `У текста «${title}» уже есть активный план.`,
    stale: 'Эта кнопка уже неактуальна',

    weekdays: ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'],
    weekdaysShort: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],

    buttons: {
      all: (total: string) => `Весь текст (${total})`,
      range: 'Выбрать диапазон…',
      later: 'Позже',
      byDeadline: '📅 По сроку',
      perDay: '🔢 По количеству в день',
      days: 'Количество дней',
      months: 'Количество месяцев',
      date: 'К дате',
      nDays: (n: number) => `${n} ${pluralRu(n, ['день', 'дня', 'дней'])}`,
      nMonths: (n: number) => `${n} ${pluralRu(n, ['месяц', 'месяца', 'месяцев'])}`,
      datePreset: (months: number, date: string) =>
        `${months === 12 ? 'Через год' : months === 6 ? 'Через полгода' : `Через ${months === 1 ? 'месяц' : `${months} месяца`}`} — ${date}`,
      restDone: 'Готово',
      restNone: 'Без выходных',
      todayStart: 'Сегодня',
      tomorrow: 'Завтра',
      reduce: 'Уменьшить нагрузку',
      force: 'Всё равно продолжить',
      go: '▶️ Начать',
      editPace: 'Изменить темп',
      editRest: 'Изменить выходные',
      editStart: 'Изменить дату начала',
      editTime: 'Изменить время',
      back: '← Назад',
    },
  },

  learn: {
    portion: (title: string, range: string) =>
      `📖 «${title}» — ${range}.\n\nВыучите и нажмите «Выучил». Повторы начнутся от этого момента.`,
    portionReplaced: (title: string, range: string) =>
      `🔁 Порция заменена: «${title}» — ${range}.\n\nВыучите и нажмите «Выучил».`,
    reminder: (title: string, range: string) =>
      `⏰ Напоминание: «${title}» — ${range}. Отметьте, когда выучите.`,
    learned: (title: string, range: string) => `✅ «${title}» — ${range}: выучено!`,
    reviewsTitle: 'Повторы:',
    reviewStages: ['через 12 часов', 'через сутки', 'через 3 дня', 'через 2 недели', 'через месяц'],
    nextSent: 'Следующая порция — ниже 👇',
    nextAt: (when: string) => `Следующая порция — ${when}.`,
    nextDebt: 'Следующая порция придёт, когда будут сделаны все повторы.',
    nextDone: 'Это была последняя порция плана 🎉 Остались только повторы.',
    nextPaused: 'Бот на паузе — следующая порция придёт после её окончания.',
    nextRetry: 'Следующую порцию пришлю через минуту-другую.',
    alreadyLearned: 'Эта порция уже отмечена «Выучил»',
    stillLearning: 'Хорошо. Нажмите «Выучил», когда выучите — до этого новая порция не придёт.',
    remindAt: (time: string) => `Напомню в ${time}`,
    contextLimit: (max: number) => `Больше нельзя — не больше ${max} раз`,
    edgeUp: 'Выше ничего нет',
    edgeDown: 'Ниже ничего нет',
    failed: 'Не получилось отправить, попробуйте ещё раз',
    stale: 'Эта кнопка уже неактуальна',
    skipQuestion: (many: string) =>
      `Какие ${many} пропустить? Они не будут приходить ни в порциях, ни в повторах, а порция пополнится следующими.`,
    skipTooMany: 'Пропустить всю порцию? Она не будет приходить ни в порциях, ни в повторах.',
    skipped: (list: string) => `⏭ Пропущено: ${list}.`,
    skippedReplaced: (endDate: string) =>
      `Порция пополнена следующими — она выше. Заучивание закончится ${endDate}.`,
    skippedNothingLeft: 'В плане больше нечего учить — остались только повторы.',
    buttons: {
      learned: '✅ Выучил',
      still: 'Ещё учу',
      later: '⏰ Позже',
      more: '🔍 Захватить больше',
      up: (one: string) => `⬆️ Ещё ${one} выше`,
      down: (one: string) => `⬇️ Ещё ${one} ниже`,
      skip: '⏭ Пропустить…',
      skipSelected: (n: number) => `⏭ Пропустить выбранные (${n})`,
      skipAll: 'Всю порцию',
      cancel: 'Отмена',
    },
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

/** «Ещё бейт / строку / страницу выше» — винительный падеж единственного числа. */
const ACCUSATIVE = {
  lines: 'строку',
  bayts: 'бейт',
  hadiths: 'хадис',
  paragraphs: 'абзац',
  pages: 'страницу',
} as const;

export function unitAccusative(strategy: ParseStrategy, unitName: UnitName): string {
  return ACCUSATIVE[unitKind(strategy, unitName)];
}

/** «бейты», «строки» — для вопроса «Какие … пропустить?». */
export function unitPluralNominative(strategy: ParseStrategy, unitName: UnitName): string {
  return RANGE_LABELS[unitKind(strategy, unitName)].toLowerCase();
}

/** Родительный падеж после «до»: «до 21 бейта», «до 72 бейтов». */
export function unitCountGenitive(n: number, strategy: ParseStrategy, unitName: UnitName): string {
  const [, singular, plural] = NOUNS[unitKind(strategy, unitName)];
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? singular : plural}`;
}

/** «бейтов», «строк» — для фраз вида «2–5 бейтов в день». */
export function unitNounMany(strategy: ParseStrategy, unitName: UnitName): string {
  return NOUNS[unitKind(strategy, unitName)][2];
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
