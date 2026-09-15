import { describe, expect, it } from 'vitest';
import { createOnboarding } from './onboarding.js';
import type { DialogSnapshot, DialogStore, UserSettings, UserSettingsStore } from './ports.js';

const USER = 1n;
const NOW = new Date('2026-09-16T20:14:00Z');

function setup(initial: Partial<UserSettings> = {}) {
  const settings: UserSettings = {
    timezone: null,
    dailySendTime: null,
    nightStart: '23:00',
    nightEnd: '07:00',
    nightPolicy: 'keep',
    eveningReminderTime: '21:00',
    onboardedAt: null,
    ...initial,
  };
  let dialog: DialogSnapshot | null = null;

  const users: UserSettingsStore = {
    getSettings: async () => ({ ...settings }),
    updateSettings: async (_userId, patch) => {
      Object.assign(settings, patch);
    },
  };
  const dialogs: DialogStore = {
    get: async () => dialog,
    set: async (_userId, next) => {
      dialog = next;
    },
    clear: async () => {
      dialog = null;
    },
  };

  const onboarding = createOnboarding({ users, dialogs });

  async function reachSendTime(iana = 'Asia/Yekaterinburg') {
    await onboarding.start(USER, NOW);
    await onboarding.pickTimezone(USER, iana, NOW);
    await onboarding.confirmTimezone(USER, NOW);
  }

  return { onboarding, settings, getDialog: () => dialog, reachSendTime };
}

describe('онбординг', () => {
  it('новый пользователь начинает с выбора пояса по России', async () => {
    const { onboarding, getDialog } = setup();
    const view = await onboarding.start(USER, NOW);
    expect(view).toMatchObject({ kind: 'choose_timezone', group: 'russia', welcome: true });
    expect(getDialog()).toMatchObject({ flow: 'onboarding', step: 'timezone' });
  });

  it('проходит настройку без ночных сообщений', async () => {
    const { onboarding, settings, getDialog } = setup();
    await onboarding.start(USER, NOW);

    const confirm = await onboarding.pickTimezone(USER, 'Asia/Yekaterinburg', NOW);
    expect(confirm).toMatchObject({
      kind: 'confirm_timezone',
      zone: { city: 'Екатеринбург', offsetMinutes: 300 },
    });

    expect(await onboarding.confirmTimezone(USER, NOW)).toMatchObject({ kind: 'choose_send_time' });
    expect(settings.timezone).toBe('Asia/Yekaterinburg');

    const done = await onboarding.handleText(USER, '8:00', NOW);
    expect(done).toMatchObject({
      kind: 'done',
      schedule: {
        newPortion: { planned: '08:00' },
        secondSlot: { planned: '20:00', atNight: false },
      },
    });
    expect(settings).toMatchObject({
      dailySendTime: '08:00',
      nightPolicy: 'keep',
      onboardedAt: NOW,
    });
    expect(getDialog()).toBeNull();
  });

  it('неверное время — остаёмся на шаге с ошибкой', async () => {
    const { onboarding, getDialog, reachSendTime, settings } = setup();
    await reachSendTime();
    const view = await onboarding.handleText(USER, 'в шесть', NOW);
    expect(view).toMatchObject({ kind: 'choose_send_time', error: 'invalid_time' });
    expect(getDialog()?.step).toBe('send_time');
    expect(settings.dailySendTime).toBeNull();
  });

  it('раннее время порции (06:00) не вызывает вопрос про ночь', async () => {
    const { onboarding, settings, reachSendTime } = setup();
    await reachSendTime();
    const done = await onboarding.handleText(USER, '06:00', NOW);
    expect(done).toMatchObject({
      kind: 'done',
      schedule: { newPortion: { planned: '06:00', atNight: false, actual: '06:00' } },
    });
    expect(settings).toMatchObject({
      dailySendTime: '06:00',
      nightPolicy: 'keep',
      onboardedAt: NOW,
    });
  });

  it('ночной повтор: «переносить на утро»', async () => {
    const { onboarding, settings, reachSendTime } = setup();
    await reachSendTime();

    const night = await onboarding.setSendTime(USER, '14:00', NOW);
    expect(night).toMatchObject({
      kind: 'choose_night_policy',
      schedule: { secondSlot: { planned: '02:00', atNight: true } },
      nightEnd: '07:00',
    });

    const done = await onboarding.chooseNightPolicy(USER, 'move', NOW);
    expect(done).toMatchObject({ kind: 'done', schedule: { secondSlot: { actual: '07:00' } } });
    expect(settings.nightPolicy).toBe('move');
  });

  it('ночной повтор: «оставить по часам»', async () => {
    const { onboarding, settings, reachSendTime } = setup();
    await reachSendTime();
    await onboarding.setSendTime(USER, '14:00', NOW);
    const done = await onboarding.chooseNightPolicy(USER, 'keep', NOW);
    expect(done).toMatchObject({ kind: 'done', schedule: { secondSlot: { actual: '02:00' } } });
    expect(settings).toMatchObject({ nightPolicy: 'keep', onboardedAt: NOW });
  });

  it('ночной повтор: своё время утра', async () => {
    const { onboarding, settings, reachSendTime } = setup();
    await reachSendTime();
    await onboarding.setSendTime(USER, '14:00', NOW);

    expect(await onboarding.chooseNightPolicy(USER, 'other', NOW)).toMatchObject({
      kind: 'choose_night_end',
    });
    expect(await onboarding.handleText(USER, '23:00', NOW)).toMatchObject({
      kind: 'choose_night_end',
      error: 'equals_night_start',
    });

    const done = await onboarding.handleText(USER, '8:30', NOW);
    expect(done).toMatchObject({ kind: 'done', schedule: { secondSlot: { actual: '08:30' } } });
    expect(settings).toMatchObject({ nightEnd: '08:30', nightPolicy: 'move' });
  });

  it('«Выбрать другой» возвращает на страницу выбранного пояса', async () => {
    const { onboarding } = setup();
    await onboarding.start(USER, NOW);
    await onboarding.openTimezoneGroup(USER, 'world', NOW);
    await onboarding.pickTimezone(USER, 'Asia/Dubai', NOW);
    expect(await onboarding.rejectTimezone(USER, NOW)).toMatchObject({
      kind: 'choose_timezone',
      group: 'world',
      welcome: false,
    });
  });

  it('старая кнопка выбора пояса после подтверждения — stale с текущим экраном', async () => {
    const { onboarding, settings, reachSendTime } = setup();
    await reachSendTime();
    const view = await onboarding.pickTimezone(USER, 'Europe/Moscow', NOW);
    expect(view).toMatchObject({ kind: 'stale', current: { kind: 'choose_send_time' } });
    expect(settings.timezone).toBe('Asia/Yekaterinburg');
  });

  it('неизвестный пояс и неизвестная группа не принимаются', async () => {
    const { onboarding } = setup();
    await onboarding.start(USER, NOW);
    expect(await onboarding.pickTimezone(USER, 'Mars/Olympus', NOW)).toMatchObject({
      kind: 'stale',
    });
    expect(await onboarding.openTimezoneGroup(USER, 'moon', NOW)).toMatchObject({ kind: 'stale' });
  });

  it('текст на шаге выбора пояса — подсказка выбрать кнопкой', async () => {
    const { onboarding } = setup();
    await onboarding.start(USER, NOW);
    expect(await onboarding.handleText(USER, 'Москва', NOW)).toMatchObject({
      kind: 'stale',
      current: { kind: 'choose_timezone' },
    });
  });

  it('настроенный пользователь при /start получает сводку', async () => {
    const { onboarding } = setup({
      timezone: 'Europe/Moscow',
      dailySendTime: '06:00',
      onboardedAt: NOW,
    });
    expect(await onboarding.start(USER, NOW)).toMatchObject({
      kind: 'summary',
      zone: { city: 'Москва' },
      schedule: { newPortion: { planned: '06:00' } },
    });
  });
});
