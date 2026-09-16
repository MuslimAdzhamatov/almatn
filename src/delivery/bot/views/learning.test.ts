import { describe, expect, it } from 'vitest';
import type { PortionAction } from '../../../app/learning.js';
import type { PortionView } from '../../../app/ports.js';
import {
  learnedMessage,
  listUnits,
  PORTION_CALLBACK,
  portionMessage,
  reminderMessage,
  skipMenu,
  skippedMessage,
  whenText,
} from './learning.js';

const view: PortionView = {
  deliveryId: 123456789,
  title: 'Манзума',
  unitName: 'bayts',
  strategy: 'numbers',
  lineStart: 41,
  lineEnd: 45,
  count: 5,
  replaced: false,
};
const portion = {
  title: 'Манзума',
  unitName: 'bayts' as const,
  strategy: 'numbers' as const,
  lineStart: 41,
  lineEnd: 45,
  timezone: 'Europe/Moscow',
};
const NOW = new Date('2026-09-16T08:00:00Z');

function callbacks(keyboard: { inline_keyboard: { text: string }[][] } | undefined) {
  return (keyboard?.inline_keyboard.flat() ?? []).map((button) =>
    'callback_data' in button ? String(button.callback_data) : '',
  );
}

describe('сообщения порции', () => {
  it('кнопки под порцией: отметки, контекст, пропуск', () => {
    const { text, keyboard } = portionMessage(view);
    expect(text).toContain('«Манзума» — бейты 41–45');
    const labels = keyboard!.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual([
      '✅ Выучил',
      'Ещё учу',
      '⏰ Позже',
      '🔍 Захватить больше',
      '⬆️ Ещё бейт выше',
      '⬇️ Ещё бейт ниже',
      '⏭ Пропустить…',
    ]);
    for (const data of callbacks(keyboard)) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(data).toMatch(PORTION_CALLBACK);
    }
    expect(portionMessage({ ...view, replaced: true }).text).toContain('Порция заменена');
  });

  it('название кнопок зависит от единицы', () => {
    const labels = (unitName: PortionView['unitName'], strategy: PortionView['strategy']) =>
      portionMessage({ ...view, unitName, strategy })
        .keyboard!.inline_keyboard.flat()
        .map((b) => b.text);
    expect(labels('lines', 'numbers')).toContain('⬆️ Ещё строку выше');
    expect(labels('hadiths', 'paragraphs')).toContain('⬇️ Ещё хадис ниже');
    expect(labels('lines', 'manual_page')).toContain('⬆️ Ещё страницу выше');
  });

  it('напоминание — только отметки', () => {
    const { text, keyboard } = reminderMessage(view);
    expect(text).toContain('Напоминание');
    expect(keyboard!.inline_keyboard.flat()).toHaveLength(3);
  });

  it('даты повторов по местному времени', () => {
    const zone = 'Europe/Moscow';
    expect(whenText(new Date('2026-09-16T15:00:00Z'), zone, NOW)).toBe('сегодня в 18:00');
    expect(whenText(new Date('2026-09-17T03:00:00Z'), zone, NOW)).toBe('завтра в 06:00');
    expect(whenText(new Date('2026-10-16T03:00:00Z'), zone, NOW)).toBe('16.10 в 06:00');
  });

  it('«Выучил»: повторы и следующая порция', () => {
    const action: Extract<PortionAction, { kind: 'learned' }> = {
      kind: 'learned',
      portion,
      withContext: true,
      reviews: [
        { stage: 'rep_12h', dueAt: new Date('2026-09-16T15:00:00Z') },
        { stage: 'rep_1d', dueAt: new Date('2026-09-17T03:00:00Z') },
      ],
      next: { kind: 'at', at: new Date('2026-09-17T03:00:00Z') },
    };
    const text = learnedMessage(action, NOW);
    expect(text).toContain('• через 12 часов — сегодня в 18:00');
    expect(text).toContain('• через сутки — завтра в 06:00');
    expect(text).toContain('Следующая порция — завтра в 06:00.');
  });
});

describe('пропуск', () => {
  it('меню с отметками и кнопкой «выбранные»', () => {
    const menu = skipMenu({
      kind: 'skip_menu',
      deliveryId: 7,
      portion,
      units: [41, 42, 43, 44, 45, 46],
      mask: 0b101n,
    });
    expect(menu.text).toContain('Какие бейты пропустить?');
    const buttons = menu.keyboard!.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual([
      '✅ 41',
      '42',
      '✅ 43',
      '44',
      '45',
      '46',
      '⏭ Пропустить выбранные (2)',
      'Всю порцию',
      'Отмена',
    ]);
    const data = callbacks(menu.keyboard);
    expect(data[1]).toBe('po:7:skt:5:1');
    expect(data[6]).toBe('po:7:sks:5');
    expect(data.every((d) => PORTION_CALLBACK.test(d))).toBe(true);
  });

  it('слишком большая порция — только «всю порцию»', () => {
    const menu = skipMenu({ kind: 'skip_menu', deliveryId: 7, portion, units: [1, 2], mask: null });
    expect(menu.keyboard!.inline_keyboard.flat().map((b) => b.text)).toEqual([
      'Всю порцию',
      'Отмена',
    ]);
  });

  it('перечень пропущенных и итог', () => {
    expect(listUnits(portion, [4])).toBe('бейт 4');
    expect(listUnits(portion, [1, 2, 3, 7, 9, 10])).toBe('бейты 1–3, 7, 9–10');
    expect(
      skippedMessage({
        kind: 'skipped',
        portion,
        skipped: [1],
        replaced: true,
        endDate: '2026-12-30',
      }),
    ).toContain('Заучивание закончится 30.12.2026');
    expect(
      skippedMessage({ kind: 'skipped', portion, skipped: [1, 2], replaced: false, endDate: null }),
    ).toContain('больше нечего учить');
  });
});
