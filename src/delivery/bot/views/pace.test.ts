import { describe, expect, it } from 'vitest';
import type { PaceNotice } from '../../../app/pace.js';
import { PACE_CALLBACK, paceChoiceMessage, paceMessage } from './pace.js';

const notice = (check: PaceNotice['check']): PaceNotice => ({
  unitName: 'bayts',
  strategy: 'numbers',
  planId: 123456789,
  title: 'Манзума',
  unitsPerDay: 5,
  check,
});
const behind = {
  kind: 'behind' as const,
  deadline: '2026-09-20',
  shiftEndDate: '2026-09-21',
  catchUpUnitsPerDay: 7,
  catchUpEndDate: '2026-09-20',
  adviseShift: false,
};
const data = (message: ReturnType<typeof paceMessage>) =>
  (message.keyboard?.inline_keyboard.flat() ?? []).map((b) =>
    'callback_data' in b ? String(b.callback_data) : '',
  );

describe('темп после задержки', () => {
  it('отставание: оба варианта', () => {
    const message = paceMessage(notice(behind));
    expect(message.text).toContain('с темпом 5 бейтов в день заучивание закончится 21.09.2026');
    expect(message.text).toContain('«Успеть к сроку» — 7 бейтов в день, к 20.09.2026');
    expect(message.text).toContain('«Сдвинуть срок» — 5 бейтов в день, до 21.09.2026');
    expect(data(message)).toEqual(['pc:123456789:c', 'pc:123456789:s']);
    expect(data(message).every((d) => PACE_CALLBACK.test(d))).toBe(true);
  });

  it('совет сдвинуть и отсутствие рабочих дней', () => {
    expect(paceMessage(notice({ ...behind, adviseShift: true })).text).toContain('советуем');
    const none = paceMessage(
      notice({ ...behind, catchUpUnitsPerDay: null, catchUpEndDate: null, adviseShift: true }),
    );
    expect(none.text).toContain('можно только сдвинуть');
    expect(data(none)).toEqual(['pc:123456789:s']);
  });

  it('по количеству в день — только новая дата', () => {
    const message = paceMessage(
      notice({ kind: 'shifted', endDate: '2026-09-21', previous: '2026-09-20' }),
    );
    expect(message.text).toBe('📅 «Манзума»: из-за задержки заучивание закончится 21.09.2026.');
    expect(message.keyboard).toBeUndefined();
  });

  it('ответ на выбор', () => {
    expect(
      paceChoiceMessage({
        kind: 'caught_up',
        title: 'Манзума',
        unit: { unitName: 'bayts', strategy: 'numbers' },
        unitsPerDay: 7,
        endDate: '2026-09-20',
      }),
    ).toBe('✅ «Манзума»: теперь 7 бейтов в день, заучивание закончится 20.09.2026.');
    expect(paceChoiceMessage({ kind: 'shifted', title: 'Манзума', endDate: '2026-09-21' })).toBe(
      '✅ «Манзума»: срок сдвинут, заучивание закончится 21.09.2026.',
    );
  });
});
