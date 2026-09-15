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

  notReadyYet: 'Эта функция появится на следующих этапах разработки.',
  unknownMessage: 'Не понял сообщение. Список команд — в меню бота.',
  unexpectedError: 'Что-то пошло не так. Попробуйте ещё раз чуть позже.',
} as const;
