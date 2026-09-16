import { describe, expect, it } from 'vitest';
import { planningDayOf } from '../core/srs/slots.js';
import { createLearning } from './learning.js';
import { at, setup, USER } from './learning.fixture.js';
import { createPause } from './pause.js';
import { createReviews } from './reviews.js';
import { createTick } from './tick.js';

// Сквозная проверка по «Definition of Done» (CLAUDE.md, раздел 8): порции, «Выучил», сводные
// повторы 12 ч / 1 д / 3 д / 2 нед / 1 мес, долг, пауза, автопауза, перезапуск бота и закрытие плана —
// на ускоренном времени, тик каждые 5 минут. 12 бейтов по 3 в день, МСК, основной слот 06:00.

const STEP = 5 * 60 * 1000;
const START = at('2026-09-16T00:00:00Z');

type T = ReturnType<typeof setup>;

/** Приложение поверх общего хранилища: новый вызов — как перезапуск процесса бота. */
function boot(t: T) {
  const deps = { store: t.store, notifier: t.notifier, images: t.images };
  const reportError = (err: unknown) => void t.errors.push(err);
  const learning = createLearning({ ...deps, reportError });
  const reviews = createReviews({ ...deps, learning, reportError });
  const pause = createPause({ ...deps, learning, reviews, dialogs: t.dialogs, reportError });
  const tick = createTick({
    withLock: t.store.withTickLock,
    steps: [
      { name: 'pause', run: pause.runDue },
      { name: 'reviews', run: reviews.runDue },
      { name: 'portions', run: learning.runDue },
    ],
    reportError,
  });
  return { learning, reviews, pause, tick };
}

type App = ReturnType<typeof boot>;

/**
 * Пользователь отвечает на всё новое, что пришло: «Выучил» и «Повторил(а)».
 * Ответ может сразу принести новую порцию — на неё тоже отвечаем.
 */
async function answer(t: T, app: App, from: number, now: Date) {
  let next = from;
  while (next < t.sent.length) {
    const messages = t.sent.slice(next);
    next = t.sent.length;
    // Любое нажатие в боте обновляет время активности.
    if (messages.some((m) => m.kind === 'portion' || m.kind === 'batch')) {
      t.user.lastActivityAt = now;
    }
    for (const message of messages) {
      if (message.kind === 'portion' && message.view) {
        await app.learning.learned(USER, message.view.deliveryId, now);
      }
      if (message.kind === 'batch' && message.batch) {
        const { deliveryId, buttons } = message.batch;
        if (buttons.learn) await app.reviews.learned(USER, deliveryId, now);
        if (buttons.confirm) await app.reviews.answer(USER, deliveryId, 'confirmed', now);
      }
    }
  }
}

/** Сколько раз каждый повтор попадал в сообщение. */
function countAttachments(t: T) {
  const counts = new Map<number, number>();
  const original = t.store.attachReviews;
  t.store.attachReviews = async (deliveryId, ids, when) => {
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    return original(deliveryId, ids, when);
  };
  return counts;
}

function expectCompleted(t: T) {
  expect(t.errors).toEqual([]);
  expect(t.plan.status).toBe('completed');
  expect(t.portions.map((p) => [p.lineStart, p.lineEnd, p.status])).toEqual([
    [1, 3, 'completed'],
    [4, 6, 'completed'],
    [7, 9, 'completed'],
    [10, 12, 'completed'],
  ]);
  const chain = t.reviews.filter((r) => r.stage !== 'learn_reminder');
  expect(chain).toHaveLength(4 * 5);
  expect(chain.every((r) => r.status === 'confirmed')).toBe(true);
  // Не больше одной новой порции за плановые сутки.
  const days = t.portions.map((p) => planningDayOf(p.sentAt, t.user));
  expect(new Set(days).size).toBe(days.length);
}

describe('сквозной сценарий', () => {
  it('дисциплинированный пользователь: пауза и перезапуск посередине, план закрыт', async () => {
    const t = setup();
    const attached = countAttachments(t);
    let app = boot(t);
    const PAUSE_FROM = at('2026-09-25T09:00:00Z');
    const PAUSE_TO = at('2026-09-27T09:00:00Z');
    const RESTART = at('2026-10-01T02:00:00Z');
    let sentDuringPause = 0;

    for (let ms = START.getTime(); ms <= at('2026-10-25T00:00:00Z').getTime(); ms += STEP) {
      const now = new Date(ms);
      if (now.getTime() === PAUSE_FROM.getTime()) await app.pause.choose(USER, 'manual', now);
      if (now.getTime() === PAUSE_TO.getTime()) {
        expect(t.sent.length).toBe(sentDuringPause);
        const from = t.sent.length;
        const resumed = await app.pause.resume(USER, now);
        expect(resumed).toMatchObject({ kind: 'resumed' });
        await answer(t, app, from, now);
      }
      if (now.getTime() === RESTART.getTime()) {
        app = boot(t);
        // Второй экземпляр в ту же минуту — дублей нет.
        await boot(t).tick(now);
      }
      const from = t.sent.length;
      await app.tick(now);
      if (now >= PAUSE_FROM && now < PAUSE_TO) {
        if (now.getTime() === PAUSE_FROM.getTime()) sentDuringPause = t.sent.length;
        continue;
      }
      await answer(t, app, from, now);
    }

    expectCompleted(t);
    // Всё отмечалось сразу: каждый повтор пришёл ровно в одном сообщении.
    expect([...attached.values()].every((n) => n === 1)).toBe(true);
    expect(attached.size).toBe(20);
    // Напоминаний про порцию и о долге не было — всё делалось вовремя.
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(0);
    expect(t.sent.filter((s) => s.batch?.kind === 'evening')).toHaveLength(0);
    // Пауза пришлась на время после заучивания — сроки не сдвигались.
    expect(t.plan.estimatedEndDate).toBe('2026-09-19');
  });

  it('пропал на полторы недели: долг раз в сутки, автопауза, возвращение, план закрыт', async () => {
    const t = setup();
    let app = boot(t);
    const GONE_FROM = START;
    const BACK = at('2026-09-28T09:00:00Z');
    const perDay = new Map<string, number>();

    for (let ms = START.getTime(); ms <= at('2026-11-05T00:00:00Z').getTime(); ms += STEP) {
      const now = new Date(ms);
      if (now.getTime() === BACK.getTime()) {
        expect(t.user.pausedFrom).not.toBeNull();
        // Возвращение — это активность (в боте её отмечает любое нажатие).
        t.user.lastActivityAt = now;
        const from = t.sent.length;
        expect(await app.pause.resume(USER, now)).toMatchObject({
          kind: 'resumed',
          debtMessages: 1,
        });
        await answer(t, app, from, now);
        app = boot(t);
      }
      const from = t.sent.length;
      await app.tick(now);
      const absent = now >= GONE_FROM && now < BACK;
      for (const message of t.sent.slice(from)) {
        if (!absent || !message.batch) continue;
        const day = planningDayOf(now, t.user);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      if (absent) continue;
      if (now > BACK) t.user.lastActivityAt = now;
      await answer(t, app, from, now);
    }

    expectCompleted(t);
    // Порция 16.09 не выучена — новых порций до возвращения нет.
    expect(t.portions[1]!.sentAt >= BACK).toBe(true);
    // Напоминание про порцию — одно.
    expect(t.sent.filter((s) => s.kind === 'reminder')).toHaveLength(1);
    // Долг дольше 3 плановых суток — не больше одного сообщения в сутки.
    for (const [day, count] of perDay) {
      if (day >= '2026-09-19') expect(count, day).toBeLessThanOrEqual(1);
    }
    // Автопауза (7 дней без активности после 15.09 12:00 при долге) — одна.
    expect(t.sent.filter((s) => s.kind === 'autopause')).toHaveLength(1);
    // На паузе сообщений о долге не было: после автопаузы 22.09 — ни одной сводки.
    expect([...perDay.keys()].filter((day) => day > '2026-09-22')).toEqual([]);
  });
});
