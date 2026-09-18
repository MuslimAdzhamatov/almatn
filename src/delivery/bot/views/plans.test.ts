import { describe, expect, it } from 'vitest';
import type { PlanScreen, UnitInfo } from '../../../app/plans.js';
import { summarizePlan } from '../../../core/plan/summary.js';
import { buildDailySchedule } from '../../../core/time/schedule.js';
import { PLAN_CALLBACK, renderPlan } from './plans.js';

const token = 'a1b2c3d4';
const unit: UnitInfo = { strategy: 'numbers', unitName: 'bayts' };
const limits = { maxUnitsPerDay: 10, maxPeakReview: 50, maxPlanDays: 1095, maxStartDelayDays: 365 };
const summary = summarizePlan(
  {
    lineFrom: 1,
    lineTo: 448,
    startDate: '2026-09-19',
    restDays: [5, 6],
    pace: { mode: 'deadline', deadline: { kind: 'date', date: '2026-12-30' } },
  },
  limits,
);
if (!summary.ok) throw new Error('расчёт не удался');
const schedule = buildDailySchedule({
  dailySendTime: '06:00',
  eveningReminderTime: '21:00',
  nightStart: '23:00',
  nightEnd: '07:00',
  nightPolicy: 'keep',
});

const screens: Exclude<PlanScreen, { kind: 'stale' }>[] = [
  { kind: 'scope', token, title: 'Манзума', total: 448, unit },
  { kind: 'scope_input', token, total: 448, unit, invalid: true },
  { kind: 'known_input', token, unit, lineFrom: 1, lineTo: 448, invalid: false },
  { kind: 'known_input', token, unit, lineFrom: 1, lineTo: 448, invalid: true },
  { kind: 'pace', token, total: 448, unit },
  { kind: 'deadline_kind', token, startDate: '2026-09-16' },
  ...(['days', 'months', 'date'] as const).map((input) => ({
    kind: 'deadline_input' as const,
    token,
    input,
    startDate: '2026-09-16',
    maxDays: 1095,
    presets: [{ months: 12, date: '2027-09-16' }],
    error: 'no_working_days' as const,
  })),
  { kind: 'per_day', token, total: 448, unit, invalid: true },
  { kind: 'rest_days', token, restDays: [5, 7] },
  { kind: 'start_date', token, today: '2026-09-16', maxDays: 365, invalid: false },
  { kind: 'send_time', token, invalid: false },
  { kind: 'overload', token, unit, summary, limits },
  {
    kind: 'confirm',
    token,
    title: 'منظومة في أحكام الفقه',
    unit,
    lineFrom: 1,
    lineTo: 448,
    knownFrom: null,
    knownTo: null,
    paceMode: 'deadline',
    startDate: '2026-09-19',
    today: '2026-09-16',
    summary,
    schedule,
    overlap: { titles: ['Второй'], upcomingTotal: 40, upcomingPeak: 10, combinedPeak: 35 },
  },
  { kind: 'started', planId: 1, title: 'Манзума', unit, summary, timezone: 'Europe/Moscow' },
  { kind: 'postponed' },
  { kind: 'already_planned', title: 'Манзума' },
];

describe('экраны создания плана', () => {
  it.each(screens.map((screen) => [screen.kind, screen] as const))('%s', (_kind, screen) => {
    const { text, keyboard } = renderPlan(screen);
    expect(text.length).toBeGreaterThan(0);
    for (const button of keyboard?.inline_keyboard.flat() ?? []) {
      const data = 'callback_data' in button ? button.callback_data : '';
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(data).toMatch(PLAN_CALLBACK);
    }
  });

  it('подтверждение: темп, выходные, первая порция, даты и наложение', () => {
    const confirm = screens.find((s) => s.kind === 'confirm')!;
    const { text } = renderPlan(confirm);
    expect(text).toContain('бейты 1–448 (448 бейтов)');
    expect(text).toContain('чтобы выучить к 30.12.2026');
    expect(text).toContain('Выходные: пятница, суббота.');
    expect(text).toContain('Первая порция — 20.09.2026');
    expect(text).toContain('последние повторы');
    expect(text).toContain('«Второй»');
    expect(text).toContain('новая порция — в 06:00');
  });

  it('выходные отмечены галочкой', () => {
    const { keyboard } = renderPlan({ kind: 'rest_days', token, restDays: [5] });
    const labels = keyboard!.inline_keyboard.flat().map((button) => button.text);
    expect(labels).toContain('✅ Пт');
    expect(labels).toContain('Пн');
  });
});
