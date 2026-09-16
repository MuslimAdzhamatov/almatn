import { describe, expect, it } from 'vitest';
import type { SettingsInfo } from '../../../app/settings.js';
import { buildDailySchedule } from '../../../core/time/schedule.js';
import { describeZone, listZones, ZONE_GROUPS } from '../../../core/time/zones.js';
import { renderSettings, SETTINGS_CALLBACK } from './settings.js';

const NOW = new Date('2026-09-16T09:00:00Z');
const info: SettingsInfo = {
  zone: describeZone('Europe/Moscow', NOW),
  schedule: buildDailySchedule({
    dailySendTime: '06:00',
    eveningReminderTime: '21:00',
    nightStart: '23:00',
    nightEnd: '07:00',
    nightPolicy: 'keep',
  }),
  nightStart: '23:00',
  nightEnd: '07:00',
  nightPolicy: 'keep',
  eveningReminderTime: '21:00',
  learnReminderDelayMin: 90,
  restDays: [5, 7],
};

const data = (message: ReturnType<typeof renderSettings>) =>
  (message.keyboard?.inline_keyboard.flat() ?? []).map((b) =>
    'callback_data' in b ? String(b.callback_data) : '',
  );

describe('экраны настроек', () => {
  it('меню', () => {
    const menu = renderSettings({
      kind: 'menu',
      info,
      saved: true,
      shifted: [{ title: 'Манзума', endDate: '2026-10-01' }],
    });
    expect(menu.text).toContain('✅ Сохранено.');
    expect(menu.text).toContain('Часовой пояс: Москва (UTC+3), сейчас 12:00, 16.09.');
    expect(menu.text).toContain('через 1 ч 30 мин');
    expect(menu.text).toContain('Выходные: пятница, воскресенье.');
    expect(menu.text).toContain('• «Манзума» — 01.10.2026');
    for (const d of data(menu)) expect(d.length).toBeGreaterThan(0);
  });

  it('все кнопки выбора пояса укладываются в лимит и распознаются', () => {
    for (const group of ZONE_GROUPS) {
      const screen = renderSettings({ kind: 'timezone', group, zones: listZones(group, NOW) });
      for (const d of data(screen)) {
        expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
        expect(SETTINGS_CALLBACK.test(d)).toBe(true);
      }
    }
  });

  it('выходные и напоминание', () => {
    const rest = renderSettings({ kind: 'rest_days', restDays: [] });
    expect(data(rest)).toContain('se:rest:-:1');
    expect(data(rest)).toContain('se:restok:-');
    const chosen = renderSettings({ kind: 'rest_days', restDays: [5, 6] });
    expect(data(chosen)).toContain('se:restok:5.6');
    const delay = renderSettings({ kind: 'learn_delay', current: 120 });
    expect(delay.keyboard?.inline_keyboard.flat().map((b) => b.text)).toContain('✅ 2 ч');
  });
});
