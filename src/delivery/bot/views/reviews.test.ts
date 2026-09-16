import { describe, expect, it } from 'vitest';
import type { BatchView } from '../../../app/ports.js';
import { PORTION_CALLBACK } from './learning.js';
import { batchKeyboard, batchMessage, rangesText, REVIEW_CALLBACK } from './reviews.js';

const unit = { unitName: 'bayts' as const, strategy: 'numbers' as const };
const view: BatchView = {
  ...unit,
  deliveryId: 123456789,
  title: 'Манзума',
  kind: 'review',
  reviews: [
    { lineStart: 1, lineEnd: 10 },
    { lineStart: 16, lineEnd: 16 },
  ],
  portion: null,
  buttons: { confirm: true, learn: null },
};

const buttons = (keyboard: ReturnType<typeof batchKeyboard>) =>
  keyboard.inline_keyboard.flat().map((b) => ({
    text: b.text,
    data: 'callback_data' in b ? String(b.callback_data) : '',
  }));

describe('сводка', () => {
  it('диапазоны', () => {
    expect(rangesText(unit, [{ lineStart: 4, lineEnd: 4 }])).toBe('бейт 4');
    expect(rangesText(unit, [{ lineStart: 1, lineEnd: 10 }])).toBe('бейты 1–10');
    expect(rangesText(unit, view.reviews)).toBe('бейты 1–10, 16');
  });

  it('повторение: отметка и кнопки контекста', () => {
    const { text, keyboard } = batchMessage(view);
    expect(text).toContain('🔁 Повторение: «Манзума» — бейты 1–10, 16.');
    const list = buttons(keyboard!);
    expect(list.map((b) => b.text)).toContain('✅ Повторил(а)');
    for (const { data } of list) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(REVIEW_CALLBACK.test(data) || PORTION_CALLBACK.test(data)).toBe(true);
    }
  });

  it('долг и вечер: что повторить и что выучить', () => {
    const debt: BatchView = {
      ...view,
      kind: 'evening',
      portion: { lineStart: 11, lineEnd: 15 },
      buttons: { confirm: true, learn: { lineStart: 11, lineEnd: 15 } },
    };
    const { text, keyboard } = batchMessage(debt);
    expect(text).toContain('Сегодня не выполнено');
    expect(text).toContain('• повторить бейты 1–10, 16');
    expect(text).toContain('• выучить бейты 11–15');
    const list = buttons(keyboard!).map((b) => b.text);
    expect(list).toEqual(expect.arrayContaining(['✅ Повторил(а) всё', '📖 Выучил бейты 11–15']));

    const onlyPortion = batchMessage({ ...debt, kind: 'debt', reviews: [] });
    expect(onlyPortion.text).toContain('Не выполнено');
    expect(onlyPortion.text).not.toContain('повторить');
  });

  it('после ответа остаются только кнопки контекста', () => {
    const keyboard = batchKeyboard({ ...view, buttons: { confirm: false, learn: null } });
    expect(buttons(keyboard).every((b) => PORTION_CALLBACK.test(b.data))).toBe(true);
  });
});
