import { describe, expect, it } from 'vitest';
import type {
  ChainToReschedule,
  DialogSnapshot,
  PlanContext,
  PlanRecord,
  UserSettings,
} from './ports.js';
import { createSettings, parseQuietHours, type SettingsScreen } from './settings.js';

const USER = 7n;
const at = (s: string) => new Date(s);
// 16.09.2026 12:00 МСК.
const NOW = at('2026-09-16T09:00:00Z');

function setup(options: { plans?: boolean } = {}) {
  const user: UserSettings = {
    timezone: 'Europe/Moscow',
    dailySendTime: '06:00',
    nightStart: '23:00',
    nightEnd: '07:00',
    nightPolicy: 'keep',
    eveningReminderTime: '21:00',
    learnReminderDelayMin: 120,
    onboardedAt: at('2026-09-01T00:00:00Z'),
  };
  let dialog: DialogSnapshot | null = null;
  const plan: PlanRecord = {
    id: 1,
    textId: 10,
    userId: USER,
    lineFrom: 1,
    lineTo: 12,
    unitsPerDay: 3,
    paceMode: 'per_day',
    startDate: '2026-09-16',
    deadlineDate: null,
    deadlineInput: null,
    restDays: [5],
    status: 'active',
    nextLine: 4,
    estimatedEndDate: '2026-09-19',
  };
  const chains: ChainToReschedule[] = [
    {
      portionId: 5,
      anchorAt: at('2026-09-16T03:00:00Z'),
      stages: [
        { id: 51, stage: 'rep_12h' },
        { id: 52, stage: 'rep_1d' },
      ],
    },
  ];
  const applied: { portionId: number; anchorAt: Date; updates: { id: number; dueAt: Date }[] }[] =
    [];
  const planPatches: unknown[] = [];
  const settings = createSettings({
    users: {
      getSettings: async () => ({ ...user }),
      updateSettings: async (_u, patch) => void Object.assign(user, patch),
    },
    dialogs: {
      get: async () => dialog,
      set: async (_u, d) => void (dialog = d),
      clear: async () => void (dialog = null),
    },
    settings: {
      futureChains: async () => chains,
      applyChain: async (portionId, anchorAt, updates) =>
        void applied.push({ portionId, anchorAt, updates: [...updates] }),
    },
    learning: {
      listOpenPlans: async () =>
        options.plans === false
          ? []
          : [
              {
                plan: { ...plan },
                text: { id: 10, title: 'Манзума' },
                user: { ...user, userId: USER },
              } as unknown as PlanContext,
            ],
      countUnits: async () => 9,
      updatePlan: async (_id, patch) => {
        planPatches.push(patch);
        Object.assign(plan, patch);
      },
    },
  });
  return { settings, user, plan, applied, planPatches, dialog: () => dialog };
}

function expectKind<K extends SettingsScreen['kind']>(screen: SettingsScreen | null, kind: K) {
  expect(screen?.kind).toBe(kind);
  return screen as Extract<SettingsScreen, { kind: K }>;
}

describe('настройки', () => {
  it('меню показывает текущие настройки и выходные планов', async () => {
    const t = setup();
    const menu = expectKind(await t.settings.open(USER, NOW), 'menu');
    expect(menu.info).toMatchObject({
      nightPolicy: 'keep',
      learnReminderDelayMin: 120,
      restDays: [5],
    });
    expect(menu.info.schedule.newPortion.planned).toBe('06:00');
    const none = setup({ plans: false });
    expect(expectKind(await none.settings.open(USER, NOW), 'menu').info.restDays).toBeNull();
  });

  it('часовой пояс: выбор, подтверждение, пересчёт повторов', async () => {
    const t = setup();
    expect(expectKind(await t.settings.act(USER, 'tz', '', '', NOW), 'timezone').group).toBe(
      'russia',
    );
    expect(await t.settings.act(USER, 'tzp', 'Mars/Base', '', NOW)).toEqual({ kind: 'stale' });
    expectKind(
      await t.settings.act(USER, 'tzp', 'Asia/Yekaterinburg', '', NOW),
      'timezone_confirm',
    );
    expect(
      expectKind(await t.settings.act(USER, 'tzok', 'Asia/Yekaterinburg', '', NOW), 'menu').saved,
    ).toBe(true);
    expect(t.user.timezone).toBe('Asia/Yekaterinburg');
    expect(t.applied).toMatchObject([
      {
        portionId: 5,
        anchorAt: at('2026-09-16T01:00:00Z'),
        updates: [
          { id: 51, dueAt: at('2026-09-16T13:00:00Z') },
          { id: 52, dueAt: at('2026-09-17T01:00:00Z') },
        ],
      },
    ]);
  });

  it('время порции: кнопкой без ночных сообщений — сразу сохранено', async () => {
    const t = setup();
    expectKind(await t.settings.act(USER, 'time', '', '', NOW), 'send_time');
    expectKind(await t.settings.act(USER, 'timeset', '07:00', '', NOW), 'menu');
    expect(t.user.dailySendTime).toBe('07:00');
    expect(t.applied[0]?.anchorAt).toEqual(at('2026-09-16T04:00:00Z'));
    // Повтор того же времени — без пересчёта.
    await t.settings.act(USER, 'timeset', '07:00', '', NOW);
    expect(t.applied).toHaveLength(1);
  });

  it('время порции текстом: ошибка, затем вопрос о ночных сообщениях', async () => {
    const t = setup();
    await t.settings.act(USER, 'time', '', '', NOW);
    expect(expectKind(await t.settings.handleText(USER, 'утром', NOW), 'send_time').invalid).toBe(
      true,
    );
    expectKind(await t.settings.handleText(USER, '14:00', NOW), 'night_policy');
    expect(t.user.dailySendTime).toBe('14:00');
    // Кнопка «другое время утра» → ввод.
    expectKind(await t.settings.act(USER, 'night', 'other', '', NOW), 'night_end');
    expect(expectKind(await t.settings.handleText(USER, '23:00', NOW), 'night_end').error).toBe(
      'equals_night_start',
    );
    expectKind(await t.settings.handleText(USER, '08:00', NOW), 'menu');
    expect(t.user).toMatchObject({ nightEnd: '08:00', nightPolicy: 'move' });
    // Диалог закрыт.
    expect(await t.settings.handleText(USER, '09:00', NOW)).toBeNull();
    expect(await t.settings.act(USER, 'night', 'keep', '', NOW)).toEqual({ kind: 'stale' });
  });

  it('тихие часы и политика', async () => {
    const t = setup();
    expectKind(await t.settings.act(USER, 'quiet', '', '', NOW), 'quiet');
    await t.settings.act(USER, 'qpol', 'move', '', NOW);
    expect(t.user.nightPolicy).toBe('move');
    await t.settings.act(USER, 'qhours', '', '', NOW);
    expect(expectKind(await t.settings.handleText(USER, '22:00', NOW), 'quiet_hours').invalid).toBe(
      true,
    );
    await t.settings.handleText(USER, '22:30 – 6:30', NOW);
    expect(t.user).toMatchObject({ nightStart: '22:30', nightEnd: '06:30' });
  });

  it('вечернее напоминание и напоминание про порцию', async () => {
    const t = setup();
    await t.settings.act(USER, 'eveset', '22:00', '', NOW);
    expect(t.user.eveningReminderTime).toBe('22:00');
    await t.settings.act(USER, 'eve', '', '', NOW);
    await t.settings.handleText(USER, '20:30', NOW);
    expect(t.user.eveningReminderTime).toBe('20:30');
    expect(
      expectKind(await t.settings.act(USER, 'delay', '', '', NOW), 'learn_delay').current,
    ).toBe(120);
    await t.settings.act(USER, 'delayset', '60', '', NOW);
    expect(t.user.learnReminderDelayMin).toBe(60);
    expect(await t.settings.act(USER, 'delayset', '5', '', NOW)).toEqual({ kind: 'stale' });
  });

  it('выходные: выбор не больше двух, сохранение пересчитывает дату окончания', async () => {
    const t = setup();
    expect(
      expectKind(await t.settings.act(USER, 'rest', '', '', NOW), 'rest_days').restDays,
    ).toEqual([5]);
    const two = expectKind(await t.settings.act(USER, 'rest', '5', '6', NOW), 'rest_days');
    expect(two.restDays).toEqual([5, 6]);
    expect(
      expectKind(await t.settings.act(USER, 'rest', '5.6', '7', NOW), 'rest_days').restDays,
    ).toEqual([5, 6]);
    expect(await t.settings.act(USER, 'restok', '1.2.3', '', NOW)).toEqual({ kind: 'stale' });

    const saved = expectKind(await t.settings.act(USER, 'restok', '5.6', '', NOW), 'menu');
    // 9 единиц по 3 — 3 рабочих дня с 17.09: чт 17, вс 20, пн 21 (пт и сб — выходные).
    expect(t.plan).toMatchObject({ restDays: [5, 6], estimatedEndDate: '2026-09-21' });
    expect(saved.shifted).toEqual([{ title: 'Манзума', endDate: '2026-09-21' }]);

    const none = setup({ plans: false });
    expect(await none.settings.act(USER, 'restok', '-', '', NOW)).toEqual({ kind: 'no_plans' });
  });

  it('смена времени из диалога плана — тоже с пересчётом', async () => {
    const t = setup();
    await t.settings.changeSendTime(USER, '08:00', NOW);
    expect(t.user.dailySendTime).toBe('08:00');
    expect(t.applied).toHaveLength(1);
  });

  it('разбор тихих часов', () => {
    expect(parseQuietHours('23:00-07:00')).toEqual({ start: '23:00', end: '07:00' });
    expect(parseQuietHours('7:00 — 7:00')).toBeNull();
    expect(parseQuietHours('ночью')).toBeNull();
  });
});
