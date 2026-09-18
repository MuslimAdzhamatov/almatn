import { describe, expect, it } from 'vitest';
import type { TextProgress } from '../../../app/library.js';
import { limits } from '../../../config/limits.js';
import { summarizePlan } from '../../../core/plan/summary.js';
import { texts } from '../texts.js';
import { LIBRARY_CALLBACK, progressLines, renderLibrary } from './library.js';
import { PACE_EDIT_CALLBACK, renderPaceEdit } from './paceEdit.js';

const unit = { unitName: 'bayts' as const, strategy: 'numbers' as const };
const text: TextProgress = {
  ...unit,
  textId: 10,
  title: 'Манзума',
  totalLines: 448,
  plan: {
    id: 3,
    status: 'active',
    paceMode: 'deadline',
    unitsPerDay: 5,
    deadlineDate: '2026-12-30',
    estimatedEndDate: '2026-12-29',
    knownUnits: 0,
    learnedUnits: 45,
    totalUnits: 448,
    percent: 10,
    reviewsDone: 30,
    reviewsMissed: 2,
    streak: 5,
    lastReviewDate: '2027-01-28',
  },
};

const data = (message: { keyboard?: { inline_keyboard: { text: string }[][] } }) =>
  (message.keyboard?.inline_keyboard.flat() ?? []).map((b) =>
    'callback_data' in b ? String(b.callback_data) : '',
  );
const known = (d: string) =>
  LIBRARY_CALLBACK.test(d) ||
  PACE_EDIT_CALLBACK.test(d) ||
  d === 'se:menu' ||
  Buffer.byteLength(d) === 0;

describe('экраны текстов', () => {
  it('прогресс текста', () => {
    expect(progressLines(text)).toEqual([
      '📖 «Манзума»',
      'Выучено: 45 из 448 бейтов (10%).',
      'Темп: 5 бейтов в день, к 30.12.2026.',
      'Заучивание закончится 29.12.2026.',
      'Повторы: сделано 30, «не успел» — 2.',
      'Дней без долгов подряд: 5.',
    ]);
    const done = progressLines({ ...text, plan: { ...text.plan!, status: 'learning_done' } });
    expect(done).toContain('Заучивание закончено ✅, последние повторы — до 28.01.2027.');
    expect(progressLines({ ...text, plan: null })).toEqual(['📖 «Манзума»', 'Плана пока нет.']);
  });

  it('список и карточка', () => {
    const list = renderLibrary({
      kind: 'texts',
      texts: [text, { ...text, textId: 11, plan: null }],
    });
    expect(list.text).toContain('1. «Манзума» — 10% (45 из 448 бейтов)');
    expect(list.text).toContain('2. «Манзума» — плана нет');
    expect(data(list)).toEqual(['lb:card:10', 'lb:card:11', 'lb:upload']);
    const card = renderLibrary({ kind: 'card', text });
    expect(data(card)).toEqual(['pe:3:open', 'lb:del:10', 'lb:list']);
    const noPlan = renderLibrary({ kind: 'card', text: { ...text, plan: null } });
    expect(data(noPlan)[0]).toBe('lb:plan:10');
    for (const d of [...data(list), ...data(card)]) expect(known(d)).toBe(true);
  });

  it('на сегодня', () => {
    const now = new Date('2026-09-16T09:00:00Z');
    const today = renderLibrary(
      {
        kind: 'today',
        timezone: 'Europe/Moscow',
        paused: null,
        texts: [
          {
            ...unit,
            textId: 10,
            title: 'Манзума',
            portion: { kind: 'debt' },
            owed: [{ lineStart: 1, lineEnd: 10, count: 10 }],
            unlearned: { lineStart: 11, lineEnd: 15 },
            later: [{ lineStart: 16, lineEnd: 20, count: 5 }],
          },
          {
            ...unit,
            textId: 11,
            title: 'Касыда',
            portion: { kind: 'at', at: new Date('2026-09-17T03:00:00Z') },
            owed: [],
            unlearned: null,
            later: [],
          },
        ],
      },
      now,
    );
    expect(today.text).toContain('Не выполнено: повторить бейты 1–10; выучить бейты 11–15.');
    expect(today.text).toContain('Ещё сегодня повторить: бейты 16–20.');
    expect(today.text).toContain('Новая порция придёт завтра в 06:00.');
    expect(today.text).toContain('Долгов нет ✅');
    expect(data(today)).toEqual(['lb:debt:10']);
  });

  it('удаление и выбор', () => {
    expect(data(renderLibrary({ kind: 'delete_confirm', textId: 10, title: 'Манзума' }))).toEqual([
      'lb:delok:10',
      'lb:list',
    ]);
    expect(data(renderLibrary({ kind: 'wipe_confirm', step: 1 }))).toEqual(['lb:wipe2', 'se:menu']);
    expect(data(renderLibrary({ kind: 'wipe_confirm', step: 2 }))).toEqual([
      'lb:wipeok',
      'se:menu',
    ]);
    const pick = renderLibrary({
      kind: 'pick',
      purpose: 'pace',
      texts: [{ id: 3, title: 'Манзума' }],
    });
    expect(data(pick)).toEqual(['pe:3:open', 'se:menu']);
  });

  it('справка перечисляет все команды меню', () => {
    for (const command of Object.keys(texts.commands)) {
      if (command !== 'start') expect(texts.help).toContain(`/${command}`);
    }
  });
});

describe('экраны смены темпа', () => {
  const target = { ...unit, planId: 3, title: 'Манзума' };

  it('выбор режима и ввод', () => {
    const mode = renderPaceEdit({
      kind: 'mode',
      target,
      paceMode: 'deadline',
      unitsPerDay: 5,
      deadlineDate: '2026-12-30',
      remaining: 403,
    });
    expect(mode.text).toContain('сейчас 5 бейтов в день, к 30.12.2026.');
    expect(mode.text).toContain('Ещё не выдано: 403 бейта.');
    const perDay = renderPaceEdit({ kind: 'per_day', target, remaining: 3, invalid: false });
    expect(data(perDay)).toEqual(['pe:3:upd:2', 'pe:3:upd:3', 'lb:list']);
    const days = renderPaceEdit({
      kind: 'deadline_input',
      target,
      input: 'days',
      from: '2026-09-17',
      maxDays: 1095,
      error: 'too_long',
    });
    expect(days.text).toContain('Слишком долгий срок — не больше 1095 дней.');
    for (const d of data(days)) expect(known(d)).toBe(true);
  });

  it('предпросмотр с предупреждением и сохранение', () => {
    const summary = summarizePlan(
      {
        lineFrom: 1,
        lineTo: 100,
        startDate: '2026-09-17',
        restDays: [],
        pace: { mode: 'per_day', unitsPerDay: 20 },
      },
      limits.plan,
    );
    if (!summary.ok) throw new Error('summary');
    const preview = renderPaceEdit({
      kind: 'preview',
      target,
      from: '2026-09-17',
      summary,
      limits: limits.plan,
    });
    expect(preview.text).toContain('Новый темп «Манзума»: 20 бейтов в день.');
    expect(preview.text).toContain('⚠️');
    expect(data(preview)).toEqual(['pe:3:save', 'pe:3:open', 'lb:list']);
    expect(
      renderPaceEdit({ kind: 'saved', target, unitsPerDay: 2, endDate: '2026-10-01' }).text,
    ).toBe('✅ «Манзума»: теперь 2 бейта в день, заучивание закончится 01.10.2026.');
  });
});
