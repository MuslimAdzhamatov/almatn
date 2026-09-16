import { describe, expect, it } from 'vitest';
import { anchorSlotOf, rescheduleChain } from './reschedule.js';

const at = (s: string) => new Date(s);
const moscow6 = { timezone: 'Europe/Moscow', dailySendTime: '06:00' };
const iso = (d: Date) => d.toISOString();

describe('пересчёт цепочки при смене настроек', () => {
  it('вид слота по прежним настройкам', () => {
    expect(anchorSlotOf(at('2026-09-16T03:00:00Z'), moscow6)).toMatchObject({
      kind: 'main',
      day: '2026-09-16',
    });
    expect(anchorSlotOf(at('2026-09-16T15:00:00Z'), moscow6)).toMatchObject({
      kind: 'second',
      day: '2026-09-16',
    });
  });

  it('новое время: тот же вид слота тех же суток', () => {
    const now = at('2026-09-16T10:00:00Z');
    const result = rescheduleChain(
      at('2026-09-16T03:00:00Z'),
      moscow6,
      { timezone: 'Europe/Moscow', dailySendTime: '08:00' },
      now,
      [
        { id: 1, stage: 'rep_12h' },
        { id: 2, stage: 'rep_1d' },
        { id: 3, stage: 'rep_1m' },
      ],
    );
    expect(iso(result.anchorAt)).toBe('2026-09-16T05:00:00.000Z');
    expect(result.updates.map((u) => [u.id, iso(u.dueAt)])).toEqual([
      [1, '2026-09-16T17:00:00.000Z'],
      [2, '2026-09-17T05:00:00.000Z'],
      [3, '2026-10-16T05:00:00.000Z'],
    ]);
  });

  it('новый пояс: те же местные часы', () => {
    const result = rescheduleChain(
      at('2026-09-16T15:00:00Z'),
      moscow6,
      { timezone: 'Asia/Yekaterinburg', dailySendTime: '06:00' },
      at('2026-09-16T16:00:00Z'),
      [{ id: 1, stage: 'rep_3d' }],
    );
    // Второй слот 16.09 — 18:00 по Екатеринбургу (13:00 UTC); +3 суток.
    expect(iso(result.anchorAt)).toBe('2026-09-16T13:00:00.000Z');
    expect(iso(result.updates[0]!.dueAt)).toBe('2026-09-19T13:00:00.000Z');
  });

  it('срок в прошлом по новым настройкам — ближайший будущий слот', () => {
    const now = at('2026-09-16T12:00:00Z');
    const result = rescheduleChain(
      at('2026-09-16T03:00:00Z'),
      moscow6,
      { timezone: 'Europe/Moscow', dailySendTime: '02:00' },
      now,
      [{ id: 1, stage: 'rep_12h' }],
    );
    // +12 ч от 02:00 — 14:00 (11:00 UTC) уже прошло; ближайший слот — 02:00 17.09.
    expect(iso(result.updates[0]!.dueAt)).toBe('2026-09-16T23:00:00.000Z');
  });
});
