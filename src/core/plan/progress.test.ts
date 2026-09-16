import { describe, expect, it } from 'vitest';
import { cleanStreak } from './progress.js';

const at = (s: string) => new Date(s);
const s = { timezone: 'Europe/Moscow', dailySendTime: '06:00' };
// Сейчас 16.09 12:00 МСК — плановые сутки 16.09.
const NOW = at('2026-09-16T09:00:00Z');

describe('серия дней без долгов', () => {
  it('всё сделано в срок — с начала плана, включая сегодня', () => {
    const duties = [
      { dueAt: at('2026-09-14T03:00:00Z'), doneAt: at('2026-09-14T04:00:00Z') },
      { dueAt: at('2026-09-15T15:00:00Z'), doneAt: at('2026-09-16T01:00:00Z') },
    ];
    expect(cleanStreak(duties, NOW, s, '2026-09-14')).toBe(3);
  });

  it('сделано после конца суток — серия с суток после этого', () => {
    const duties = [{ dueAt: at('2026-09-13T03:00:00Z'), doneAt: at('2026-09-15T05:00:00Z') }];
    // 13 и 14 — с долгом, 15 и 16 — чистые.
    expect(cleanStreak(duties, NOW, s, '2026-09-01')).toBe(2);
  });

  it('долг сейчас — ноль', () => {
    const duties = [{ dueAt: at('2026-09-16T03:00:00Z'), doneAt: null }];
    expect(cleanStreak(duties, NOW, s, '2026-09-01')).toBe(15);
    const old = [{ dueAt: at('2026-09-15T03:00:00Z'), doneAt: null }];
    expect(cleanStreak(old, NOW, s, '2026-09-01')).toBe(0);
  });

  it('вчерашний долг закрыт сегодня — засчитываются только сегодняшние сутки', () => {
    const duties = [{ dueAt: at('2026-09-15T03:00:00Z'), doneAt: at('2026-09-16T04:00:00Z') }];
    expect(cleanStreak(duties, NOW, s, '2026-09-01')).toBe(1);
  });

  it('будущие дела не учитываются, план ещё не начался — ноль', () => {
    expect(
      cleanStreak([{ dueAt: at('2026-09-20T03:00:00Z'), doneAt: null }], NOW, s, '2026-09-16'),
    ).toBe(1);
    expect(cleanStreak([], NOW, s, '2026-09-20')).toBe(0);
  });
});
