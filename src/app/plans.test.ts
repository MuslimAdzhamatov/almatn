import { describe, expect, it } from 'vitest';
import { createPlans, type PlanScreen } from './plans.js';
import type {
  DialogSnapshot,
  DialogStore,
  NewPlan,
  OpenPlan,
  PlanRecord,
  PlansStore,
  ScheduledReview,
  TextRecord,
  TextsStore,
  UserSettings,
  UserSettingsStore,
} from './ports.js';

const USER = 7n;
const OTHER_USER = 8n;
// 16.09.2026, среда; в Москве 11:00.
const NOW = new Date('2026-09-16T08:00:00Z');
const LIMITS = { maxUnitsPerDay: 10, maxPeakReview: 50, maxPlanDays: 1100, maxStartDelayDays: 365 };

function makeText(id: number, patch: Partial<TextRecord> = {}): TextRecord {
  return {
    id,
    userId: USER,
    title: `Текст ${id}`,
    unitName: 'bayts',
    sourceKind: 'pdf',
    originalFileName: `t${id}.pdf`,
    filePath: `/t${id}.pdf`,
    fileSize: 1,
    sha256: `sha${id}`,
    pageCount: 33,
    totalLines: 448,
    parseStrategy: 'numbers',
    status: 'ready',
    parseReport: null,
    parseRequest: null,
    parseError: null,
    createdAt: NOW,
    ...patch,
  };
}

function setup() {
  const texts = new Map<number, TextRecord>([
    [1, makeText(1)],
    [2, makeText(2, { title: 'Второй', totalLines: 20 })],
    [3, makeText(3, { status: 'awaiting_confirm' })],
    [4, makeText(4, { userId: OTHER_USER })],
  ]);
  const textsStore = { get: async (id: number) => texts.get(id) ?? null } as TextsStore;

  const settings: UserSettings = {
    timezone: 'Europe/Moscow',
    dailySendTime: '06:00',
    nightStart: '23:00',
    nightEnd: '07:00',
    nightPolicy: 'keep',
    eveningReminderTime: '21:00',
    onboardedAt: NOW,
  };
  const users: UserSettingsStore = {
    getSettings: async () => ({ ...settings }),
    updateSettings: async (_id, patch) => void Object.assign(settings, patch),
  };

  const dialogMap = new Map<bigint, DialogSnapshot>();
  const dialogs: DialogStore = {
    get: async (id) => structuredClone(dialogMap.get(id) ?? null),
    set: async (id, dialog) => void dialogMap.set(id, structuredClone(dialog)),
    clear: async (id) => void dialogMap.delete(id),
  };

  const planRows: PlanRecord[] = [];
  const reviews: ScheduledReview[] = [];
  const isOpen = (p: PlanRecord) => p.status === 'active' || p.status === 'learning_done';
  const plans: PlansStore = {
    create: async (plan: NewPlan) => {
      if (planRows.some((p) => p.textId === plan.textId && isOpen(p))) return null;
      const row: PlanRecord = { ...plan, id: planRows.length + 1, status: 'active' };
      planRows.push(row);
      return row;
    },
    findOpenByText: async (textId) =>
      planRows.find((p) => p.textId === textId && isOpen(p)) ?? null,
    listOpenByUser: async (userId): Promise<OpenPlan[]> =>
      planRows
        .filter((p) => p.userId === userId && isOpen(p))
        .map((p) => ({ ...p, textTitle: texts.get(p.textId)!.title })),
    scheduledReviews: async () => reviews,
  };

  let token = 0;
  const service = createPlans({
    plans,
    texts: textsStore,
    users,
    dialogs,
    limits: LIMITS,
    newToken: () => `tok${++token}`,
  });
  return { service, planRows, reviews, settings, dialogMap, texts };
}

type Service = ReturnType<typeof setup>['service'];

function expectKind<K extends PlanScreen['kind']>(
  screen: PlanScreen | null,
  kind: K,
): Extract<PlanScreen, { kind: K }> {
  expect(screen?.kind).toBe(kind);
  return screen as Extract<PlanScreen, { kind: K }>;
}

/** Весь текст → по количеству в день → N → выходные. */
async function toConfirm(service: Service, perDay: number, restDays: number[] = []) {
  const scope = expectKind(await service.begin(USER, 1, NOW), 'scope');
  const t = scope.token;
  await service.act(USER, t, 'all', '', NOW);
  await service.act(USER, t, 'pace', 'per_day', NOW);
  expectKind(await service.act(USER, t, 'upd', String(perDay), NOW), 'rest_days');
  for (const day of restDays) await service.act(USER, t, 'rest', String(day), NOW);
  return { token: t, screen: await service.act(USER, t, 'restok', '', NOW) };
}

describe('создание плана', () => {
  it('по количеству в день: расчёт, подтверждение и сохранение', async () => {
    const { service, planRows, dialogMap } = setup();
    const { token, screen } = await toConfirm(service, 5, [5]);
    const confirm = expectKind(screen, 'confirm');
    expect(confirm.summary).toMatchObject({ unitsPerDay: 5, portions: 90, restDays: [5] });
    expect(confirm.schedule.newPortion.planned).toBe('06:00');
    expect(confirm.overlap).toBeNull();

    const started = expectKind(await service.act(USER, token, 'go', '', NOW), 'started');
    expect(started.sendTime).toBe('06:00');
    expect(planRows).toEqual([
      expect.objectContaining({
        textId: 1,
        userId: USER,
        lineFrom: 1,
        lineTo: 448,
        unitsPerDay: 5,
        paceMode: 'per_day',
        startDate: '2026-09-16',
        deadlineDate: null,
        deadlineInput: null,
        restDays: [5],
        nextLine: 1,
        estimatedEndDate: confirm.summary.endDate,
        status: 'active',
      }),
    ]);
    expect(dialogMap.has(USER)).toBe(false);
    // После сохранения кнопки диалога неактуальны.
    expectKind(await service.act(USER, token, 'go', '', NOW), 'stale');
  });

  it('по сроку в месяцах, диапазон единиц', async () => {
    const { service, planRows } = setup();
    const { token } = expectKind(await service.begin(USER, 1, NOW), 'scope');
    expectKind(await service.act(USER, token, 'range', '', NOW), 'scope_input');
    expectKind(await service.handleText(USER, '500', NOW), 'scope_input');
    expectKind(await service.handleText(USER, '101-190', NOW), 'pace');
    expectKind(await service.act(USER, token, 'pace', 'deadline', NOW), 'deadline_kind');
    const input = expectKind(
      await service.act(USER, token, 'dlk', 'months', NOW),
      'deadline_input',
    );
    expect(input.input).toBe('months');
    expectKind(await service.handleText(USER, 'месяц', NOW), 'deadline_input');
    expectKind(await service.handleText(USER, '1', NOW), 'rest_days');
    const confirm = expectKind(await service.act(USER, token, 'restnone', '', NOW), 'confirm');
    expect(confirm).toMatchObject({ lineFrom: 101, lineTo: 190, paceMode: 'deadline' });
    expect(confirm.summary).toMatchObject({ unitsPerDay: 3, deadlineDate: '2026-10-15' });

    await service.act(USER, token, 'go', '', NOW);
    expect(planRows[0]).toMatchObject({
      lineFrom: 101,
      lineTo: 190,
      nextLine: 101,
      paceMode: 'deadline',
      deadlineInput: 'months:1',
      deadlineDate: '2026-10-15',
    });
  });

  it('срок к дате: подсказки, неверный ввод, дата раньше начала', async () => {
    const { service } = setup();
    const { token } = expectKind(await service.begin(USER, 2, NOW), 'scope');
    await service.act(USER, token, 'all', '', NOW);
    await service.act(USER, token, 'pace', 'deadline', NOW);
    const input = expectKind(await service.act(USER, token, 'dlk', 'date', NOW), 'deadline_input');
    expect(input.presets.map((p) => p.date)).toEqual([
      '2026-10-16',
      '2026-12-16',
      '2027-03-16',
      '2027-09-16',
    ]);
    expect(
      expectKind(await service.handleText(USER, '31.02.2027', NOW), 'deadline_input').error,
    ).toBe('format');
    expect(
      expectKind(await service.handleText(USER, '01.01.2030', NOW), 'deadline_input').error,
    ).toBe('too_long');
    expectKind(await service.handleText(USER, '25.09.2026', NOW), 'rest_days');
    // Сдвиг даты начала после срока-даты: срок оказывается раньше начала.
    await service.act(USER, token, 'restok', '', NOW);
    expectKind(await service.act(USER, token, 'edit', 'start', NOW), 'start_date');
    expectKind(await service.handleText(USER, '15.09.2026', NOW), 'start_date');
    const error = expectKind(await service.handleText(USER, '30.09.2026', NOW), 'deadline_input');
    expect(error).toMatchObject({ input: 'date', error: 'deadline_before_start' });
    expectKind(await service.act(USER, token, 'dlv', 'date:2026-10-30', NOW), 'confirm');
  });

  it('срок без рабочих дней', async () => {
    const { service } = setup();
    const { token } = expectKind(await service.begin(USER, 2, NOW), 'scope');
    await service.act(USER, token, 'all', '', NOW);
    await service.act(USER, token, 'pace', 'deadline', NOW);
    await service.act(USER, token, 'dlk', 'days', NOW);
    await service.handleText(USER, '1', NOW);
    await service.act(USER, token, 'rest', '3', NOW);
    const error = expectKind(await service.act(USER, token, 'restok', '', NOW), 'deadline_input');
    expect(error.error).toBe('no_working_days');
  });

  it('выходные: не больше двух', async () => {
    const { service } = setup();
    const { token } = expectKind(await service.begin(USER, 1, NOW), 'scope');
    await service.act(USER, token, 'all', '', NOW);
    await service.act(USER, token, 'pace', 'per_day', NOW);
    await service.act(USER, token, 'upd', '3', NOW);
    await service.act(USER, token, 'rest', '5', NOW);
    await service.act(USER, token, 'rest', '6', NOW);
    const rest = expectKind(await service.act(USER, token, 'rest', '7', NOW), 'rest_days');
    expect(rest.restDays).toEqual([5, 6]);
    expect(
      expectKind(await service.act(USER, token, 'rest', '5', NOW), 'rest_days').restDays,
    ).toEqual([6]);
  });

  it('норма больше числа единиц — повторный ввод', async () => {
    const { service } = setup();
    const { token } = expectKind(await service.begin(USER, 2, NOW), 'scope');
    await service.act(USER, token, 'all', '', NOW);
    await service.act(USER, token, 'pace', 'per_day', NOW);
    expect(expectKind(await service.handleText(USER, '21', NOW), 'per_day').invalid).toBe(true);
    expect(expectKind(await service.handleText(USER, 'пять', NOW), 'per_day').invalid).toBe(true);
    expectKind(await service.handleText(USER, '20', NOW), 'rest_days');
  });

  it('перегрузка: предупреждение, «Уменьшить» и «Всё равно продолжить»', async () => {
    const { service } = setup();
    const { token, screen } = await toConfirm(service, 15);
    const overload = expectKind(screen, 'overload');
    expect(overload.summary.overload).toEqual({ unitsPerDay: true, peak: true });
    expectKind(await service.act(USER, token, 'reduce', '', NOW), 'pace');
    // После выбора темпа выходные уже выбраны — сразу расчёт.
    expectKind(await service.act(USER, token, 'upd', '12', NOW), 'overload');
    expectKind(await service.act(USER, token, 'force', '', NOW), 'confirm');
    // Изменение темпа снова показывает предупреждение.
    await service.act(USER, token, 'edit', 'pace', NOW);
    expectKind(await service.act(USER, token, 'upd', '11', NOW), 'overload');
    expectKind(await service.act(USER, token, 'upd', '4', NOW), 'confirm');
  });

  it('дата начала и время порции', async () => {
    const { service, settings, planRows } = setup();
    const { token } = await toConfirm(service, 5);
    const start = expectKind(await service.act(USER, token, 'edit', 'start', NOW), 'start_date');
    expect(start.today).toBe('2026-09-16');
    expectKind(await service.handleText(USER, '2026-10-01', NOW), 'start_date');
    expectKind(await service.handleText(USER, '01.10.2027', NOW), 'start_date');
    const confirm = expectKind(await service.handleText(USER, '1.10.2026', NOW), 'confirm');
    expect(confirm.summary.firstDate).toBe('2026-10-01');
    expectKind(await service.act(USER, token, 'edit', 'time', NOW), 'send_time');
    expect(expectKind(await service.handleText(USER, '25:00', NOW), 'send_time').invalid).toBe(
      true,
    );
    const changed = expectKind(await service.handleText(USER, '20:30', NOW), 'confirm');
    expect(changed.schedule.newPortion.planned).toBe('20:30');
    expect(settings.dailySendTime).toBe('20:30');
    expectKind(await service.act(USER, token, 'start', 'tomorrow', NOW), 'confirm');
    await service.act(USER, token, 'go', '', NOW);
    expect(planRows[0]?.startDate).toBe('2026-09-17');
  });

  it('наложение на открытый план другого текста', async () => {
    const { service, reviews } = setup();
    const first = await toConfirm(service, 5, [5]);
    await service.act(USER, first.token, 'go', '', NOW);
    reviews.push({ dueAt: new Date('2026-09-16T15:00:00Z'), units: 4 });

    const { token } = expectKind(await service.begin(USER, 2, NOW), 'scope');
    await service.act(USER, token, 'all', '', NOW);
    await service.act(USER, token, 'pace', 'per_day', NOW);
    await service.act(USER, token, 'upd', '2', NOW);
    // Выходные по умолчанию — из прошлого плана.
    const rest = expectKind(await service.act(USER, token, 'rest', '1', NOW), 'rest_days');
    expect(rest.restDays).toEqual([1, 5]);
    const confirm = expectKind(await service.act(USER, token, 'restok', '', NOW), 'confirm');
    expect(confirm.overlap?.titles).toEqual(['Текст 1']);
    expect(confirm.overlap?.upcomingTotal).toBeGreaterThan(4);
    expect(confirm.overlap?.combinedPeak).toBeGreaterThan(confirm.summary.load.peak);
  });

  it('второй открытый план на тот же текст не создаётся', async () => {
    const { service, planRows } = setup();
    const a = await toConfirm(service, 5);
    // Пока диалог открыт, план успели создать другим путём.
    planRows.push({
      ...planRows[0]!,
      id: 99,
      textId: 1,
      userId: USER,
      status: 'active',
    } as PlanRecord);
    expectKind(await service.act(USER, a.token, 'go', '', NOW), 'already_planned');
    expectKind(await service.begin(USER, 1, NOW), 'already_planned');
  });

  it('чужой, неготовый текст и старые кнопки', async () => {
    const { service, dialogMap, texts } = setup();
    expectKind(await service.begin(USER, 3, NOW), 'stale');
    expectKind(await service.begin(USER, 4, NOW), 'stale');
    expectKind(await service.begin(USER, 99, NOW), 'stale');

    const { token } = expectKind(await service.begin(USER, 1, NOW), 'scope');
    expectKind(await service.act(USER, 'other', 'all', '', NOW), 'stale');
    expectKind(await service.act(OTHER_USER, token, 'all', '', NOW), 'stale');
    expectKind(await service.act(USER, token, 'unknown', '', NOW), 'stale');
    // На шаге с кнопками текст не перехватывается.
    expect(await service.handleText(USER, 'привет', NOW)).toBeNull();

    // Новый диалог делает кнопки старого неактуальными.
    await service.begin(USER, 1, NOW);
    expectKind(await service.act(USER, token, 'all', '', NOW), 'stale');

    // Текст удалён — диалог закрывается.
    texts.delete(1);
    expect(await service.handleText(USER, '5', NOW)).toBeNull();
    expect(dialogMap.has(USER)).toBe(false);
  });

  it('«Позже» закрывает диалог', async () => {
    const { service, dialogMap } = setup();
    const { token } = expectKind(await service.begin(USER, 1, NOW), 'scope');
    expectKind(await service.act(USER, token, 'later', '', NOW), 'postponed');
    expect(dialogMap.has(USER)).toBe(false);
  });
});
