import { MAX_REST_DAYS, normalizeRestDays, toggleRestDay } from '../core/plan/calendar.js';
import type { IsoDate } from '../core/plan/dates.js';
import { estimateEndDate } from '../core/scheduler/rules.js';
import { rescheduleChain } from '../core/srs/reschedule.js';
import { planningDayOf, type SlotSettings } from '../core/srs/slots.js';
import { formatHHmm, parseHHmm } from '../core/time/hhmm.js';
import { buildDailySchedule, type DailySchedule, type NightPolicy } from '../core/time/schedule.js';
import {
  describeZone,
  findZoneOption,
  isZoneGroup,
  listZones,
  type ZoneGroup,
  type ZoneNow,
} from '../core/time/zones.js';
import type {
  DialogStore,
  LearningStore,
  PlanShift,
  SettingsStore,
  UserSettings,
  UserSettingsPatch,
  UserSettingsStore,
} from './ports.js';

// /settings (CLAUDE.md, раздел 5.5): часовой пояс, время новой порции, тихие часы, вечернее
// напоминание, напоминание про порцию, выходные. Каждое изменение — с показом нового расписания.
// Смена пояса или времени пересчитывает ещё не наступившие повторы (раздел 5.4, п. 6).

const FLOW = 'settings';

/** Шаги, где ждём ответ текстом. */
type TextStep = 'send_time' | 'night_end' | 'quiet_hours' | 'evening';

export const LEARN_DELAY_PRESETS = [30, 60, 120, 180, 240] as const;
const MAX_LEARN_DELAY_MIN = 12 * 60;

export interface SettingsInfo {
  zone: ZoneNow;
  schedule: DailySchedule;
  nightStart: string;
  nightEnd: string;
  nightPolicy: NightPolicy;
  eveningReminderTime: string;
  learnReminderDelayMin: number;
  /** Выходные открытых планов; null — планов нет. */
  restDays: number[] | null;
}

export type SettingsScreen =
  | { kind: 'menu'; info: SettingsInfo; saved: boolean; shifted: PlanShift[] }
  | { kind: 'timezone'; group: ZoneGroup; zones: ZoneNow[] }
  | { kind: 'timezone_confirm'; zone: ZoneNow }
  | { kind: 'send_time'; current: string; invalid: boolean }
  | { kind: 'night_policy'; schedule: DailySchedule; nightStart: string; nightEnd: string }
  | { kind: 'night_end'; nightStart: string; error: 'invalid_time' | 'equals_night_start' | null }
  | { kind: 'quiet'; nightStart: string; nightEnd: string; nightPolicy: NightPolicy }
  | { kind: 'quiet_hours'; invalid: boolean }
  | { kind: 'evening'; current: string; invalid: boolean }
  | { kind: 'learn_delay'; current: number }
  | { kind: 'rest_days'; restDays: number[] }
  | { kind: 'no_plans' }
  | { kind: 'stale' };

type Configured = UserSettings & { timezone: string; dailySendTime: string };

export interface SettingsDeps {
  users: UserSettingsStore;
  dialogs: DialogStore;
  settings: SettingsStore;
  learning: Pick<LearningStore, 'listOpenPlans' | 'countUnits' | 'updatePlan'>;
}

/** «23:00-07:00», «23:00 – 07:00». */
export function parseQuietHours(input: string): { start: string; end: string } | null {
  const match = /^\s*(\S+)\s*[-–—]\s*(\S+)\s*$/.exec(input);
  const start = match && parseHHmm(match[1]!);
  const end = match && parseHHmm(match[2]!);
  if (!start || !end) return null;
  const range = { start: formatHHmm(start), end: formatHHmm(end) };
  return range.start === range.end ? null : range;
}

export function createSettings({ users, dialogs, settings, learning }: SettingsDeps) {
  async function load(userId: bigint): Promise<Configured | null> {
    const s = await users.getSettings(userId);
    return s?.onboardedAt && s.timezone && s.dailySendTime ? (s as Configured) : null;
  }

  async function currentRestDays(userId: bigint): Promise<number[] | null> {
    const plans = (await learning.listOpenPlans(userId)).filter((p) => p.plan.status === 'active');
    return plans.at(-1)?.plan.restDays ?? null;
  }

  async function menu(userId: bigint, now: Date, saved = false, shifted: PlanShift[] = []) {
    await dialogs.clear(userId);
    const s = await load(userId);
    if (!s) return { kind: 'stale' } as const;
    return {
      kind: 'menu',
      saved,
      shifted,
      info: {
        zone: describeZone(s.timezone, now),
        schedule: buildDailySchedule(s),
        nightStart: s.nightStart,
        nightEnd: s.nightEnd,
        nightPolicy: s.nightPolicy,
        eveningReminderTime: s.eveningReminderTime,
        learnReminderDelayMin: s.learnReminderDelayMin,
        restDays: await currentRestDays(userId),
      },
    } satisfies SettingsScreen;
  }

  async function ask(userId: bigint, step: TextStep) {
    await dialogs.set(userId, { flow: FLOW, step, data: {} });
  }

  /** Повторы, которые ещё не наступили, — на те же слоты по новым настройкам. */
  async function reschedule(userId: bigint, before: SlotSettings, after: SlotSettings, now: Date) {
    if (before.timezone === after.timezone && before.dailySendTime === after.dailySendTime) return;
    for (const chain of await settings.futureChains(userId, now)) {
      const result = rescheduleChain(chain.anchorAt, before, after, now, chain.stages);
      await settings.applyChain(chain.portionId, result.anchorAt, result.updates);
    }
  }

  async function save(userId: bigint, s: Configured, patch: UserSettingsPatch, now: Date) {
    await users.updateSettings(userId, patch);
    const after = { ...s, ...patch } as Configured;
    await reschedule(userId, s, after, now);
    return after;
  }

  async function setSendTime(userId: bigint, input: string, now: Date): Promise<SettingsScreen> {
    const s = await load(userId);
    if (!s) return { kind: 'stale' };
    const time = parseHHmm(input);
    if (!time) {
      await ask(userId, 'send_time');
      return { kind: 'send_time', current: s.dailySendTime, invalid: true };
    }
    const after = await save(userId, s, { dailySendTime: formatHHmm(time) }, now);
    // Как в первом запуске: если часть сообщений попадает на ночь — спросить, что с ними делать.
    const schedule = buildDailySchedule({ ...after, nightPolicy: 'keep' });
    if (!schedule.hasNightEntries) return menu(userId, now, true);
    await dialogs.set(userId, { flow: FLOW, step: 'night_policy', data: {} });
    return {
      kind: 'night_policy',
      schedule: buildDailySchedule(after),
      nightStart: after.nightStart,
      nightEnd: after.nightEnd,
    };
  }

  async function setNightEnd(userId: bigint, input: string, now: Date): Promise<SettingsScreen> {
    const s = await load(userId);
    if (!s) return { kind: 'stale' };
    const time = parseHHmm(input);
    const nightEnd = time && formatHHmm(time);
    const error = !nightEnd
      ? 'invalid_time'
      : nightEnd === s.nightStart
        ? 'equals_night_start'
        : null;
    if (error || !nightEnd) {
      await ask(userId, 'night_end');
      return { kind: 'night_end', nightStart: s.nightStart, error };
    }
    await users.updateSettings(userId, { nightEnd, nightPolicy: 'move' });
    return menu(userId, now, true);
  }

  async function setQuietHours(userId: bigint, input: string, now: Date): Promise<SettingsScreen> {
    const range = parseQuietHours(input);
    if (!range) {
      await ask(userId, 'quiet_hours');
      return { kind: 'quiet_hours', invalid: true };
    }
    await users.updateSettings(userId, { nightStart: range.start, nightEnd: range.end });
    return menu(userId, now, true);
  }

  async function setEvening(userId: bigint, input: string, now: Date): Promise<SettingsScreen> {
    const s = await load(userId);
    if (!s) return { kind: 'stale' };
    const time = parseHHmm(input);
    if (!time) {
      await ask(userId, 'evening');
      return { kind: 'evening', current: s.eveningReminderTime, invalid: true };
    }
    await users.updateSettings(userId, { eveningReminderTime: formatHHmm(time) });
    return menu(userId, now, true);
  }

  /** Выходные — для всех идущих планов; дата окончания пересчитывается. */
  async function setRestDays(userId: bigint, days: number[], now: Date): Promise<SettingsScreen> {
    const plans = (await learning.listOpenPlans(userId)).filter((p) => p.plan.status === 'active');
    if (plans.length === 0) return { kind: 'no_plans' };
    const shifted: PlanShift[] = [];
    for (const { plan, text, user } of plans) {
      const remaining = await learning.countUnits(text.id, plan.nextLine, plan.lineTo);
      const today: IsoDate = planningDayOf(now, user);
      const endDate = estimateEndDate(today, remaining, plan.unitsPerDay, days, plan.startDate);
      await learning.updatePlan(plan.id, { restDays: days, estimatedEndDate: endDate });
      if (endDate !== plan.estimatedEndDate) shifted.push({ title: text.title, endDate });
    }
    return menu(userId, now, true, shifted);
  }

  /** Выходные из callback_data: «-» — нет, иначе дни через «.». */
  function parseDays(arg: string): number[] | null {
    if (arg === '-' || arg === '') return [];
    const days = arg.split('.').map(Number);
    if (days.length > MAX_REST_DAYS) return null;
    if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) return null;
    const normalized = normalizeRestDays(days);
    return normalized.length === days.length ? normalized : null;
  }

  return {
    open: (userId: bigint, now: Date) => menu(userId, now),

    /** Кнопка настроек: action и arg — из callback_data (`se:<action>[:<arg>[:<arg2>]]`). */
    async act(
      userId: bigint,
      action: string,
      arg: string,
      arg2: string,
      now: Date,
    ): Promise<SettingsScreen> {
      const s = await load(userId);
      if (!s) return { kind: 'stale' };
      switch (action) {
        case 'menu':
          return menu(userId, now);
        case 'tz': {
          const group = isZoneGroup(arg) ? arg : (findZoneOption(s.timezone)?.group ?? 'russia');
          return { kind: 'timezone', group, zones: listZones(group, now) };
        }
        case 'tzp':
          if (!findZoneOption(arg)) break;
          return { kind: 'timezone_confirm', zone: describeZone(arg, now) };
        case 'tzok':
          if (!findZoneOption(arg)) break;
          await save(userId, s, { timezone: arg }, now);
          return menu(userId, now, true);
        case 'time':
          await ask(userId, 'send_time');
          return { kind: 'send_time', current: s.dailySendTime, invalid: false };
        case 'timeset':
          return setSendTime(userId, arg, now);
        case 'night': {
          const dialog = await dialogs.get(userId);
          if (dialog?.flow !== FLOW || dialog.step !== 'night_policy') break;
          if (arg === 'keep' || arg === 'move') {
            await users.updateSettings(userId, { nightPolicy: arg });
            return menu(userId, now, true);
          }
          if (arg === 'other') {
            await ask(userId, 'night_end');
            return { kind: 'night_end', nightStart: s.nightStart, error: null };
          }
          break;
        }
        case 'quiet':
          await dialogs.clear(userId);
          return { kind: 'quiet', ...s };
        case 'qpol':
          if (arg !== 'keep' && arg !== 'move') break;
          await users.updateSettings(userId, { nightPolicy: arg });
          return menu(userId, now, true);
        case 'qhours':
          await ask(userId, 'quiet_hours');
          return { kind: 'quiet_hours', invalid: false };
        case 'eve':
          await ask(userId, 'evening');
          return { kind: 'evening', current: s.eveningReminderTime, invalid: false };
        case 'eveset':
          return setEvening(userId, arg, now);
        case 'delay':
          await dialogs.clear(userId);
          return { kind: 'learn_delay', current: s.learnReminderDelayMin };
        case 'delayset': {
          const minutes = Number(arg);
          if (!Number.isInteger(minutes) || minutes < 15 || minutes > MAX_LEARN_DELAY_MIN) break;
          await users.updateSettings(userId, { learnReminderDelayMin: minutes });
          return menu(userId, now, true);
        }
        case 'rest': {
          await dialogs.clear(userId);
          const current = arg ? parseDays(arg) : await currentRestDays(userId);
          if (current === null) return { kind: 'no_plans' };
          const day = Number(arg2);
          const days = arg2 ? toggleRestDay(current, day) : current;
          return { kind: 'rest_days', restDays: days };
        }
        case 'restok': {
          const days = parseDays(arg);
          if (!days) break;
          return setRestDays(userId, days, now);
        }
      }
      return { kind: 'stale' };
    },

    /** Ответ текстом на шаге ввода; null — пользователь не в настройках. */
    async handleText(userId: bigint, input: string, now: Date): Promise<SettingsScreen | null> {
      const dialog = await dialogs.get(userId);
      if (dialog?.flow !== FLOW) return null;
      switch (dialog.step as TextStep) {
        case 'send_time':
          return setSendTime(userId, input, now);
        case 'night_end':
          return setNightEnd(userId, input, now);
        case 'quiet_hours':
          return setQuietHours(userId, input, now);
        case 'evening':
          return setEvening(userId, input, now);
        default:
          return null;
      }
    },

    /** Смена времени из диалога создания плана — с пересчётом повторов. */
    async changeSendTime(userId: bigint, time: string, now: Date): Promise<void> {
      const s = await load(userId);
      if (s) await save(userId, s, { dailySendTime: time }, now);
    },
  };
}

export type Settings = ReturnType<typeof createSettings>;
