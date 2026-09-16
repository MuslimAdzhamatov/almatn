import { describe, expect, it } from 'vitest';
import { checkPace, type PaceCheckInput } from './catchup.js';

// 16.09.2026 — среда.
const base: PaceCheckInput = {
  today: '2026-09-16',
  remainingUnits: 20,
  unitsPerDay: 5,
  restDays: [],
  startDate: '2026-09-01',
  paceMode: 'deadline',
  deadlineDate: '2026-09-20',
  estimatedEndDate: '2026-09-20',
};

describe('успеть к сроку', () => {
  it('укладываемся в срок — всё в порядке', () => {
    expect(checkPace(base)).toEqual({ kind: 'on_track', endDate: '2026-09-20' });
  });

  it('задержка в пределах запаса срока — только новая расчётная дата', () => {
    expect(checkPace({ ...base, remainingUnits: 16, estimatedEndDate: '2026-09-19' })).toEqual({
      kind: 'on_track',
      endDate: '2026-09-20',
    });
  });

  it('отстали на порцию — выбор: новая норма на оставшиеся рабочие дни или новая дата', () => {
    expect(checkPace({ ...base, remainingUnits: 25 })).toEqual({
      kind: 'behind',
      deadline: '2026-09-20',
      shiftEndDate: '2026-09-21',
      catchUpUnitsPerDay: 7,
      catchUpEndDate: '2026-09-20',
      adviseShift: false,
    });
  });

  it('выходные учитываются при пересчёте нормы', () => {
    // Выходные — сб и вс: до срока остались чт и пт.
    const check = checkPace({ ...base, restDays: [6, 7], remainingUnits: 15 });
    expect(check).toMatchObject({
      kind: 'behind',
      shiftEndDate: '2026-09-21',
      catchUpUnitsPerDay: 8,
      catchUpEndDate: '2026-09-18',
    });
  });

  it('норма выросла больше чем вдвое — совет сдвинуть срок', () => {
    expect(checkPace({ ...base, remainingUnits: 60 })).toMatchObject({
      kind: 'behind',
      catchUpUnitsPerDay: 15,
      adviseShift: true,
    });
  });

  it('до срока нет рабочих дней — только сдвинуть', () => {
    expect(checkPace({ ...base, today: '2026-09-20', remainingUnits: 5 })).toEqual({
      kind: 'behind',
      deadline: '2026-09-20',
      shiftEndDate: '2026-09-21',
      catchUpUnitsPerDay: null,
      catchUpEndDate: null,
      adviseShift: true,
    });
  });

  it('учить больше нечего', () => {
    expect(checkPace({ ...base, remainingUnits: 0 })).toEqual({
      kind: 'on_track',
      endDate: '2026-09-16',
    });
  });

  it('по количеству в день — дата просто сдвигается', () => {
    const perDay = { ...base, paceMode: 'per_day' as const, deadlineDate: null };
    expect(checkPace({ ...perDay, remainingUnits: 25 })).toEqual({
      kind: 'shifted',
      endDate: '2026-09-21',
      previous: '2026-09-20',
    });
    expect(checkPace(perDay)).toEqual({ kind: 'on_track', endDate: '2026-09-20' });
  });
});
