import { describe, expect, it } from 'vitest';
import { noticeMessage, PAUSE_SET_CALLBACK, renderPause, RESUME_CALLBACK } from './pause.js';

const data = (message: ReturnType<typeof renderPause>) =>
  (message.keyboard?.inline_keyboard.flat() ?? []).map((b) =>
    'callback_data' in b ? String(b.callback_data) : '',
  );

describe('экраны паузы', () => {
  it('меню длительности', () => {
    const menu = renderPause({ kind: 'menu' });
    expect(menu.text).toContain('На сколько?');
    expect(data(menu)).toEqual([
      'pause:set:d1',
      'pause:set:w1',
      'pause:set:w2',
      'pause:set:w3',
      'pause:set:m1',
      'pause:set:date',
      'pause:set:manual',
    ]);
    expect(data(menu).every((d) => PAUSE_SET_CALLBACK.test(d))).toBe(true);
  });

  it('пауза до даты и до продолжения', () => {
    const until = renderPause({
      kind: 'paused',
      until: new Date('2026-09-22T03:00:00Z'),
      timezone: 'Europe/Moscow',
    });
    expect(until.text).toBe('⏸ Пауза до 22.09.2026. Продолжим в 06:00 22.09.');
    expect(data(until)).toEqual([RESUME_CALLBACK]);
    expect(renderPause({ kind: 'paused', until: null, timezone: 'UTC' }).text).toContain(
      '«Продолжить»',
    );
  });

  it('продолжение и сдвиг сроков', () => {
    const text = renderPause({
      kind: 'resumed',
      debtMessages: 1,
      shifted: [
        { title: 'Манзума', endDate: '2026-10-01' },
        { title: 'Без даты', endDate: null },
      ],
    }).text;
    expect(text).toContain('Сначала — повторы выше');
    expect(text).toContain('• «Манзума» — заучивание закончится 01.10.2026');
    expect(text).not.toContain('Без даты');
  });

  it('служебные сообщения', () => {
    expect(noticeMessage({ kind: 'autopause' }).keyboard).toBeDefined();
    const warning = noticeMessage({
      kind: 'pause_warning',
      until: new Date('2026-09-22T03:00:00Z'),
      timezone: 'Europe/Moscow',
    });
    expect(warning.text).toBe('⏰ Завтра в 06:00 продолжаем заучивание.');
    expect(noticeMessage({ kind: 'pause_ended', debtMessages: 0, shifted: [] })).toEqual({
      text: '▶️ Пауза закончилась, продолжаем!',
    });
  });
});
