import { describe, expect, it } from 'vitest';
import { at, MAIN, minutes, setup, USER } from './learning.fixture.js';

// 16.09.2026, МСК, основной слот 06:00 (03:00 UTC).
const NOON = at('2026-09-16T09:00:00Z');
const MAIN_23 = at('2026-09-23T03:00:00Z');

type T = ReturnType<typeof setup>;
const notices = (t: T, kind: string) => t.sent.filter((s) => s.kind === kind);
const batches = (t: T) => t.sent.filter((s) => s.kind === 'batch');

describe('ручная пауза', () => {
  it('меню, пауза на неделю, ничего не приходит, накануне — предупреждение', async () => {
    const t = setup();
    expect(await t.pause.open(USER, NOON)).toEqual({ kind: 'menu' });
    expect(await t.pause.choose(USER, 'w1', NOON)).toEqual({
      kind: 'paused',
      until: MAIN_23,
      timezone: 'Europe/Moscow',
    });
    expect(t.user).toMatchObject({ pausedFrom: NOON, pausedUntil: MAIN_23 });
    expect(await t.pause.open(USER, NOON)).toMatchObject({ kind: 'paused', until: MAIN_23 });

    await t.tick(at('2026-09-17T03:00:00Z'));
    expect(t.portions).toHaveLength(0);
    await t.tick(minutes(MAIN_23, -24 * 60 - 1));
    expect(notices(t, 'pause_warning')).toHaveLength(0);
    await t.tick(minutes(MAIN_23, -24 * 60));
    await t.tick(minutes(MAIN_23, -60));
    expect(notices(t, 'pause_warning')).toHaveLength(1);
  });

  it('окончание по времени: сообщение, сдвиг сроков, порция в тот же слот', async () => {
    const t = setup();
    Object.assign(t.plan, { paceMode: 'deadline', deadlineDate: '2026-09-20' });
    await t.pause.choose(USER, 'w1', NOON);
    await t.tick(MAIN_23);
    expect(t.user.pausedFrom).toBeNull();
    expect(t.plan).toMatchObject({ deadlineDate: '2026-09-27', estimatedEndDate: '2026-09-26' });
    expect(notices(t, 'pause_ended')).toMatchObject([
      {
        notice: {
          debtMessages: 0,
          shifted: [{ title: 'Манзума', endDate: '2026-09-26' }],
        },
      },
    ]);
    expect(t.portions).toMatchObject([{ seq: 1, sentAt: MAIN_23 }]);
  });

  it('долг после паузы — одна сводка, основной слот её не дублирует', async () => {
    const t = setup();
    await t.tick(MAIN);
    await t.pause.choose(USER, 'd1', NOON);
    const MAIN_17 = at('2026-09-17T03:00:00Z');
    await t.tick(MAIN_17);
    await t.tick(minutes(MAIN_17, 1));
    expect(batches(t)).toMatchObject([
      { batch: { kind: 'debt', portion: { lineStart: 1, lineEnd: 3 } } },
    ]);
    expect(notices(t, 'pause_ended')).toMatchObject([{ notice: { debtMessages: 1 } }]);
    // Пауза короче 2 дней — без предупреждения.
    expect(notices(t, 'pause_warning')).toHaveLength(0);
  });

  it('до даты: ввод проверяется', async () => {
    const t = setup();
    expect(await t.pause.choose(USER, 'date', NOON)).toMatchObject({
      kind: 'ask_date',
      invalid: false,
    });
    expect(await t.pause.handleText(USER, 'завтра', NOON)).toMatchObject({ invalid: true });
    expect(await t.pause.handleText(USER, '16.09.2026', NOON)).toMatchObject({ invalid: true });
    expect(await t.pause.handleText(USER, '01.10.2027', NOON)).toMatchObject({ invalid: true });
    expect(await t.pause.handleText(USER, '01.10.2026', NOON)).toMatchObject({
      kind: 'paused',
      until: at('2026-10-01T03:00:00Z'),
    });
    // Диалог закрыт — дальше текст не перехватывается.
    expect(await t.pause.handleText(USER, '02.10.2026', NOON)).toBeNull();
  });

  it('пока сам не продолжу: «Продолжить сейчас» сдвигает сроки на прошедшие дни', async () => {
    const t = setup();
    await t.pause.choose(USER, 'manual', NOON);
    expect(t.user).toMatchObject({ pausedFrom: NOON, pausedUntil: null });
    await t.tick(at('2026-09-20T03:00:00Z'));
    expect(t.portions).toHaveLength(0);

    const resumeAt = at('2026-09-20T05:00:00Z');
    expect(await t.pause.resume(USER, resumeAt)).toEqual({
      kind: 'resumed',
      debtMessages: 0,
      shifted: [{ title: 'Манзума', endDate: '2026-09-23' }],
    });
    expect(t.portions).toHaveLength(1);
    expect(await t.pause.resume(USER, resumeAt)).toEqual({ kind: 'not_paused' });
  });

  it('продление паузы — сдвиг от настоящего начала', async () => {
    const t = setup();
    await t.pause.choose(USER, 'd1', NOON);
    await t.pause.choose(USER, 'w1', minutes(NOON, 60));
    expect(t.user.pausedFrom).toEqual(NOON);
  });

  it('неизвестная кнопка — неактуальна', async () => {
    const t = setup();
    expect(await t.pause.choose(USER, 'y5', NOON)).toEqual({ kind: 'stale' });
  });
});

describe('после паузы', () => {
  it('автопауза не срабатывает сразу после долгой паузы без нажатий', async () => {
    const t = setup();
    await t.pause.choose(USER, 'm1', NOON);
    await t.tick(at('2026-10-16T03:00:00Z'));
    expect(t.user.pausedFrom).toBeNull();
    expect(t.user.lastActivityAt).toEqual(at('2026-10-16T03:00:00Z'));
    expect(notices(t, 'autopause')).toHaveLength(0);
  });
});
