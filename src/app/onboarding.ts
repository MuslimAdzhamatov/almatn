import { formatHHmm, parseHHmm } from '../core/time/hhmm.js';
import { buildDailySchedule, type DailySchedule } from '../core/time/schedule.js';
import {
  describeZone,
  findZoneOption,
  isZoneGroup,
  listZones,
  type ZoneGroup,
  type ZoneNow,
} from '../core/time/zones.js';
import type { DialogSnapshot, DialogStore, UserSettings, UserSettingsStore } from './ports.js';

// Первый запуск (CLAUDE.md, раздел 5.4): часовой пояс → время новой порции → ночные сообщения.

const FLOW = 'onboarding';

type Step = 'timezone' | 'timezone_confirm' | 'send_time' | 'night_policy' | 'night_end';

export type OnboardingScreen =
  | { kind: 'choose_timezone'; group: ZoneGroup; zones: ZoneNow[]; welcome: boolean }
  | { kind: 'confirm_timezone'; zone: ZoneNow }
  | { kind: 'choose_send_time'; zone: ZoneNow; error?: 'invalid_time' }
  | { kind: 'choose_night_policy'; schedule: DailySchedule; nightStart: string; nightEnd: string }
  | { kind: 'choose_night_end'; nightStart: string; error?: 'invalid_time' | 'equals_night_start' }
  | { kind: 'done'; zone: ZoneNow; schedule: DailySchedule }
  | { kind: 'summary'; zone: ZoneNow; schedule: DailySchedule };

/** stale — действие не подходит к текущему шагу (старая кнопка, текст вместо кнопки); current — актуальный экран. */
export type OnboardingView = OnboardingScreen | { kind: 'stale'; current: OnboardingScreen };

export interface OnboardingDeps {
  users: UserSettingsStore;
  dialogs: DialogStore;
}

export function createOnboarding({ users, dialogs }: OnboardingDeps) {
  async function requireSettings(userId: bigint): Promise<UserSettings> {
    const settings = await users.getSettings(userId);
    if (!settings) throw new Error(`Пользователь ${userId} не найден`);
    return settings;
  }

  function isConfigured(
    s: UserSettings,
  ): s is UserSettings & { timezone: string; dailySendTime: string; onboardedAt: Date } {
    return s.onboardedAt !== null && s.timezone !== null && s.dailySendTime !== null;
  }

  function scheduleFor(s: UserSettings, dailySendTime: string): DailySchedule {
    return buildDailySchedule({ ...s, dailySendTime });
  }

  async function loadDialog(userId: bigint): Promise<DialogSnapshot | null> {
    const dialog = await dialogs.get(userId);
    return dialog?.flow === FLOW ? dialog : null;
  }

  async function goTo(userId: bigint, step: Step, data: Record<string, unknown> = {}) {
    await dialogs.set(userId, { flow: FLOW, step, data });
  }

  async function showTimezones(
    userId: bigint,
    group: ZoneGroup,
    now: Date,
    welcome: boolean,
  ): Promise<OnboardingScreen> {
    await goTo(userId, 'timezone', { group });
    return { kind: 'choose_timezone', group, zones: listZones(group, now), welcome };
  }

  async function finish(userId: bigint, now: Date): Promise<OnboardingScreen> {
    await users.updateSettings(userId, { onboardedAt: now });
    await dialogs.clear(userId);
    const s = await requireSettings(userId);
    if (!isConfigured(s)) throw new Error('Настройка расписания не сохранилась');
    return {
      kind: 'done',
      zone: describeZone(s.timezone, now),
      schedule: scheduleFor(s, s.dailySendTime),
    };
  }

  async function current(userId: bigint, now: Date): Promise<OnboardingScreen> {
    const s = await requireSettings(userId);
    if (isConfigured(s)) {
      return {
        kind: 'summary',
        zone: describeZone(s.timezone, now),
        schedule: scheduleFor(s, s.dailySendTime),
      };
    }
    const dialog = await loadDialog(userId);
    if (dialog) {
      const { iana, group } = dialog.data;
      switch (dialog.step as Step) {
        case 'timezone':
          return showTimezones(
            userId,
            typeof group === 'string' && isZoneGroup(group) ? group : 'russia',
            now,
            false,
          );
        case 'timezone_confirm':
          if (typeof iana === 'string' && findZoneOption(iana)) {
            return { kind: 'confirm_timezone', zone: describeZone(iana, now) };
          }
          break;
        case 'send_time':
          if (s.timezone) return { kind: 'choose_send_time', zone: describeZone(s.timezone, now) };
          break;
        case 'night_policy':
          if (s.dailySendTime) {
            return {
              kind: 'choose_night_policy',
              schedule: scheduleFor(s, s.dailySendTime),
              nightStart: s.nightStart,
              nightEnd: s.nightEnd,
            };
          }
          break;
        case 'night_end':
          return { kind: 'choose_night_end', nightStart: s.nightStart };
      }
    }
    return showTimezones(userId, 'russia', now, true);
  }

  async function stale(userId: bigint, now: Date): Promise<OnboardingView> {
    return { kind: 'stale', current: await current(userId, now) };
  }

  /** Выполняет действие, только если пользователь сейчас на одном из разрешённых шагов. */
  async function atStep(
    userId: bigint,
    now: Date,
    allowed: Step[],
    action: (dialog: DialogSnapshot, settings: UserSettings) => Promise<OnboardingView>,
  ): Promise<OnboardingView> {
    const settings = await requireSettings(userId);
    const dialog = isConfigured(settings) ? null : await loadDialog(userId);
    if (!dialog || !allowed.includes(dialog.step as Step)) return stale(userId, now);
    return action(dialog, settings);
  }

  async function start(userId: bigint, now: Date): Promise<OnboardingScreen> {
    const s = await requireSettings(userId);
    if (isConfigured(s)) return current(userId, now);
    return showTimezones(userId, 'russia', now, true);
  }

  const openTimezoneGroup = (userId: bigint, group: string, now: Date) =>
    atStep(userId, now, ['timezone', 'timezone_confirm'], async () =>
      isZoneGroup(group) ? showTimezones(userId, group, now, false) : stale(userId, now),
    );

  const pickTimezone = (userId: bigint, iana: string, now: Date) =>
    atStep(userId, now, ['timezone'], async () => {
      if (!findZoneOption(iana)) return stale(userId, now);
      await goTo(userId, 'timezone_confirm', { iana });
      return { kind: 'confirm_timezone', zone: describeZone(iana, now) };
    });

  const rejectTimezone = (userId: bigint, now: Date) =>
    atStep(userId, now, ['timezone_confirm'], async (dialog) => {
      const { iana } = dialog.data;
      const group = typeof iana === 'string' ? findZoneOption(iana)?.group : undefined;
      return showTimezones(userId, group ?? 'russia', now, false);
    });

  const confirmTimezone = (userId: bigint, now: Date) =>
    atStep(userId, now, ['timezone_confirm'], async (dialog) => {
      const { iana } = dialog.data;
      if (typeof iana !== 'string' || !findZoneOption(iana)) return stale(userId, now);
      await users.updateSettings(userId, { timezone: iana });
      await goTo(userId, 'send_time');
      return { kind: 'choose_send_time', zone: describeZone(iana, now) };
    });

  const setSendTime = (userId: bigint, input: string, now: Date) =>
    atStep(userId, now, ['send_time'], async (_dialog, s) => {
      if (!s.timezone) return stale(userId, now);
      const time = parseHHmm(input);
      if (!time) {
        return {
          kind: 'choose_send_time',
          zone: describeZone(s.timezone, now),
          error: 'invalid_time',
        };
      }
      const dailySendTime = formatHHmm(time);
      await users.updateSettings(userId, { dailySendTime });
      const schedule = buildDailySchedule({ ...s, dailySendTime, nightPolicy: 'keep' });
      if (!schedule.hasNightEntries) {
        await users.updateSettings(userId, { nightPolicy: 'keep' });
        return finish(userId, now);
      }
      await goTo(userId, 'night_policy');
      return {
        kind: 'choose_night_policy',
        schedule,
        nightStart: s.nightStart,
        nightEnd: s.nightEnd,
      };
    });

  const chooseNightPolicy = (userId: bigint, choice: string, now: Date) =>
    atStep(userId, now, ['night_policy'], async (_dialog, s) => {
      if (choice === 'keep' || choice === 'move') {
        await users.updateSettings(userId, { nightPolicy: choice });
        return finish(userId, now);
      }
      if (choice === 'other') {
        await goTo(userId, 'night_end');
        return { kind: 'choose_night_end', nightStart: s.nightStart };
      }
      return stale(userId, now);
    });

  const setNightEnd = (userId: bigint, input: string, now: Date) =>
    atStep(userId, now, ['night_end'], async (_dialog, s) => {
      const time = parseHHmm(input);
      if (!time)
        return { kind: 'choose_night_end', nightStart: s.nightStart, error: 'invalid_time' };
      const nightEnd = formatHHmm(time);
      if (nightEnd === s.nightStart) {
        return { kind: 'choose_night_end', nightStart: s.nightStart, error: 'equals_night_start' };
      }
      await users.updateSettings(userId, { nightEnd, nightPolicy: 'move' });
      return finish(userId, now);
    });

  /** Текстовое сообщение во время настройки: время на шагах ввода, иначе — подсказка выбрать кнопкой. */
  async function handleText(userId: bigint, text: string, now: Date): Promise<OnboardingView> {
    const dialog = await loadDialog(userId);
    if (dialog?.step === 'send_time') return setSendTime(userId, text, now);
    if (dialog?.step === 'night_end') return setNightEnd(userId, text, now);
    return stale(userId, now);
  }

  return {
    start,
    current,
    openTimezoneGroup,
    pickTimezone,
    rejectTimezone,
    confirmTimezone,
    setSendTime,
    chooseNightPolicy,
    setNightEnd,
    handleText,
  };
}

export type Onboarding = ReturnType<typeof createOnboarding>;
