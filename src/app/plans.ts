import { randomBytes } from 'node:crypto';
import { buildPortionCalendar, toggleRestDay } from '../core/plan/calendar.js';
import {
  addDays,
  addMonths,
  diffDays,
  localDate,
  parseUserDate,
  type IsoDate,
} from '../core/plan/dates.js';
import { reviewEvents, type LoadEvent } from '../core/plan/load.js';
import {
  forecastOverlap,
  remainingPlanEvents,
  type OverlapForecast,
} from '../core/plan/overlap.js';
import {
  decodeDeadlineInput,
  encodeDeadlineInput,
  DAYS_IN_MONTH,
  type DeadlineInput,
  type PaceInput,
} from '../core/plan/pace.js';
import { summarizePlan, type PlanSummary } from '../core/plan/summary.js';
import { formatHHmm, parseHHmm } from '../core/time/hhmm.js';
import { buildDailySchedule, type DailySchedule } from '../core/time/schedule.js';
import type {
  DialogStore,
  ParseStrategy,
  PlansStore,
  TextRecord,
  TextsStore,
  UnitName,
  UserSettings,
  UserSettingsStore,
} from './ports.js';
import { parsePageRange } from './texts.js';

// Создание плана заучивания (CLAUDE.md, раздел 5.3): что учить → темп → выходные → расчёт → подтверждение.
// Черновик плана и шаг диалога хранятся в DialogState, поэтому диалог переживает перезапуск бота.

const FLOW = 'plan_create';

type Step =
  | 'scope'
  | 'scope_input'
  | 'pace'
  | 'deadline_kind'
  | 'deadline_input'
  | 'per_day'
  | 'rest_days'
  | 'start_date'
  | 'send_time'
  | 'overload'
  | 'confirm';

type DeadlineKind = DeadlineInput['kind'];

interface Draft {
  /** Одноразовый токен диалога в callback_data: кнопки прошлых диалогов не срабатывают. */
  token: string;
  textId: number;
  lineFrom: number;
  lineTo: number;
  startDate: IsoDate;
  restDays: number[];
  /** Выходные уже выбирались в этом диалоге — после темпа сразу к расчёту. */
  restChosen: boolean;
  pace: PaceInput | null;
  deadlineKind: DeadlineKind | null;
  /** Пользователь видел предупреждение о перегрузке и решил продолжить. */
  overloadAck: boolean;
}

export interface PlanLimits {
  /** Больше стольких новых единиц в день — мягкое предупреждение. */
  maxUnitsPerDay: number;
  /** Больше стольких единиц повтора на пике — мягкое предупреждение. */
  maxPeakReview: number;
  /** Самый длинный срок плана в днях. */
  maxPlanDays: number;
  /** На сколько дней вперёд можно отложить начало. */
  maxStartDelayDays: number;
}

export interface UnitInfo {
  strategy: ParseStrategy;
  unitName: UnitName;
}

export interface PlanOverlap extends OverlapForecast {
  titles: string[];
}

export type DeadlineError = 'format' | 'too_long' | 'deadline_before_start' | 'no_working_days';

export type PlanScreen =
  | { kind: 'scope'; token: string; title: string; total: number; unit: UnitInfo }
  | { kind: 'scope_input'; token: string; total: number; unit: UnitInfo; invalid: boolean }
  | { kind: 'pace'; token: string; total: number; unit: UnitInfo }
  | { kind: 'deadline_kind'; token: string; startDate: IsoDate }
  | {
      kind: 'deadline_input';
      token: string;
      input: DeadlineKind;
      startDate: IsoDate;
      maxDays: number;
      /** Подсказки «через месяц / 3 месяца / полгода / год» для ввода даты. */
      presets: { months: number; date: IsoDate }[];
      error: DeadlineError | null;
    }
  | {
      kind: 'per_day';
      token: string;
      total: number;
      unit: UnitInfo;
      invalid: boolean;
    }
  | { kind: 'rest_days'; token: string; restDays: number[] }
  | { kind: 'start_date'; token: string; today: IsoDate; maxDays: number; invalid: boolean }
  | { kind: 'send_time'; token: string; invalid: boolean }
  | { kind: 'overload'; token: string; unit: UnitInfo; summary: PlanSummary; limits: PlanLimits }
  | {
      kind: 'confirm';
      token: string;
      title: string;
      unit: UnitInfo;
      lineFrom: number;
      lineTo: number;
      paceMode: PaceInput['mode'];
      startDate: IsoDate;
      today: IsoDate;
      summary: PlanSummary;
      schedule: DailySchedule;
      overlap: PlanOverlap | null;
    }
  | {
      kind: 'started';
      title: string;
      unit: UnitInfo;
      summary: PlanSummary;
      today: IsoDate;
      sendTime: string;
    }
  | { kind: 'postponed' }
  | { kind: 'already_planned'; title: string }
  | { kind: 'stale' };

export interface PlansDeps {
  plans: PlansStore;
  texts: TextsStore;
  users: UserSettingsStore;
  dialogs: DialogStore;
  limits: PlanLimits;
  newToken?: () => string;
}

const DEADLINE_KINDS: readonly DeadlineKind[] = ['days', 'months', 'date'];
const isDeadlineKind = (value: string): value is DeadlineKind =>
  DEADLINE_KINDS.includes(value as DeadlineKind);

const TEXT_STEPS: readonly Step[] = [
  'scope_input',
  'deadline_input',
  'per_day',
  'start_date',
  'send_time',
];

const unitOf = (text: TextRecord): UnitInfo => ({
  strategy: text.parseStrategy ?? 'manual_page',
  unitName: text.unitName,
});

const parsePositive = (input: string): number | null => {
  const value = Number(input.trim());
  return Number.isInteger(value) && value >= 1 ? value : null;
};

type Configured = UserSettings & { timezone: string; dailySendTime: string };

export function createPlans({
  plans,
  texts,
  users,
  dialogs,
  limits,
  newToken = () => randomBytes(4).toString('hex'),
}: PlansDeps) {
  async function requireSettings(userId: bigint): Promise<Configured> {
    const settings = await users.getSettings(userId);
    if (!settings?.timezone || !settings.dailySendTime) {
      throw new Error(`Расписание пользователя ${userId} не настроено`);
    }
    return settings as Configured;
  }

  async function readyText(userId: bigint, textId: number): Promise<TextRecord | null> {
    const text = await texts.get(textId);
    return text?.userId === userId && text.status === 'ready' ? text : null;
  }

  interface Session {
    step: Step;
    draft: Draft;
    text: TextRecord;
  }

  /** Текущий диалог создания плана; null — диалога нет, токен не совпал или текст исчез. */
  async function load(userId: bigint, token?: string): Promise<Session | null> {
    const dialog = await dialogs.get(userId);
    if (dialog?.flow !== FLOW) return null;
    // Черновик записывает только этот сценарий, поэтому форме данных доверяем.
    const draft = dialog.data as unknown as Draft;
    if (token !== undefined && draft.token !== token) return null;
    const text = await readyText(userId, draft.textId);
    if (!text) {
      await dialogs.clear(userId);
      return null;
    }
    return { step: dialog.step as Step, draft, text };
  }

  async function save(userId: bigint, step: Step, draft: Draft) {
    await dialogs.set(userId, {
      flow: FLOW,
      step,
      data: draft as unknown as Record<string, unknown>,
    });
  }

  /** Шаги, экран которых не требует расчёта и «сегодня». */
  type SimpleStep = Exclude<Step, 'start_date' | 'overload' | 'confirm'>;

  async function show(userId: bigint, step: SimpleStep, s: Session): Promise<PlanScreen> {
    await save(userId, step, s.draft);
    const { draft, text } = s;
    const total = text.totalLines;
    const unit = unitOf(text);
    const token = draft.token;
    switch (step) {
      case 'scope':
        return { kind: 'scope', token, title: text.title, total, unit };
      case 'scope_input':
        return { kind: 'scope_input', token, total, unit, invalid: false };
      case 'pace':
        return { kind: 'pace', token, total: draft.lineTo - draft.lineFrom + 1, unit };
      case 'deadline_kind':
        return { kind: 'deadline_kind', token, startDate: draft.startDate };
      case 'deadline_input':
        return deadlineScreen(draft, null);
      case 'per_day':
        return {
          kind: 'per_day',
          token,
          total: draft.lineTo - draft.lineFrom + 1,
          unit,
          invalid: false,
        };
      case 'rest_days':
        return { kind: 'rest_days', token, restDays: draft.restDays };
      case 'send_time':
        return { kind: 'send_time', token, invalid: false };
    }
  }

  function deadlineScreen(draft: Draft, error: DeadlineError | null): PlanScreen {
    return {
      kind: 'deadline_input',
      token: draft.token,
      input: draft.deadlineKind ?? 'days',
      startDate: draft.startDate,
      maxDays: limits.maxPlanDays,
      presets: [1, 3, 6, 12].map((months) => ({
        months,
        date: addMonths(draft.startDate, months),
      })),
      error,
    };
  }

  async function startDateScreen(
    userId: bigint,
    s: Session,
    now: Date,
    invalid = false,
  ): Promise<PlanScreen> {
    await save(userId, 'start_date', s.draft);
    const settings = await requireSettings(userId);
    return {
      kind: 'start_date',
      token: s.draft.token,
      today: localDate(now, settings.timezone),
      maxDays: limits.maxStartDelayDays,
      invalid,
    };
  }

  /** Повторы по другим открытым планам пользователя: уже созданные и от ещё не выданных порций. */
  async function overlapFor(
    userId: bigint,
    s: Session,
    summary: PlanSummary,
    settings: Configured,
    today: IsoDate,
  ): Promise<PlanOverlap | null> {
    const others = (await plans.listOpenByUser(userId)).filter((p) => p.textId !== s.text.id);
    if (others.length === 0) return null;
    const existing: LoadEvent[] = [
      ...(await plans.scheduledReviews(userId, s.text.id)).map((review) => ({
        date: localDate(review.dueAt, settings.timezone),
        units: review.units,
      })),
      ...others.flatMap((plan) => remainingPlanEvents(plan, today)),
    ];
    const added = reviewEvents(
      buildPortionCalendar({
        lineFrom: s.draft.lineFrom,
        lineTo: s.draft.lineTo,
        unitsPerDay: summary.unitsPerDay,
        startDate: s.draft.startDate,
        restDays: summary.restDays,
      }),
    );
    return {
      titles: others.map((plan) => plan.textTitle),
      ...forecastOverlap(existing, added, today, { from: summary.firstDate, to: summary.endDate }),
    };
  }

  /** Расчёт плана: ошибка срока → снова ввод срока; перегрузка → предупреждение; иначе подтверждение. */
  async function review(userId: bigint, s: Session, now: Date): Promise<PlanScreen> {
    const { draft, text } = s;
    if (!draft.pace) return show(userId, 'pace', s);
    const summary = summarizePlan(
      {
        lineFrom: draft.lineFrom,
        lineTo: draft.lineTo,
        startDate: draft.startDate,
        restDays: draft.restDays,
        pace: draft.pace,
      },
      limits,
    );
    if (!summary.ok) {
      await save(userId, 'deadline_input', draft);
      return deadlineScreen(draft, summary.reason);
    }
    const unit = unitOf(text);
    if ((summary.overload.unitsPerDay || summary.overload.peak) && !draft.overloadAck) {
      await save(userId, 'overload', draft);
      return { kind: 'overload', token: draft.token, unit, summary, limits };
    }
    await save(userId, 'confirm', draft);
    const settings = await requireSettings(userId);
    const today = localDate(now, settings.timezone);
    return {
      kind: 'confirm',
      token: draft.token,
      title: text.title,
      unit,
      lineFrom: draft.lineFrom,
      lineTo: draft.lineTo,
      paceMode: draft.pace.mode,
      startDate: draft.startDate,
      today,
      summary,
      schedule: buildDailySchedule(settings),
      overlap: await overlapFor(userId, s, summary, settings, today),
    };
  }

  /** Изменение, влияющее на расчёт: предупреждение о перегрузке нужно показать заново. */
  function changed(s: Session, patch: Partial<Draft>): Session {
    return { ...s, draft: { ...s.draft, ...patch, overloadAck: false } };
  }

  async function afterPace(userId: bigint, s: Session, now: Date): Promise<PlanScreen> {
    return s.draft.restChosen ? review(userId, s, now) : show(userId, 'rest_days', s);
  }

  /** Срок из кнопки или ввода — с проверкой границ. */
  async function setDeadline(
    userId: bigint,
    s: Session,
    deadline: DeadlineInput,
    now: Date,
  ): Promise<PlanScreen> {
    const { startDate } = s.draft;
    const days =
      deadline.kind === 'days'
        ? deadline.value
        : deadline.kind === 'months'
          ? deadline.value * DAYS_IN_MONTH
          : diffDays(startDate, deadline.date) + 1;
    if (days > limits.maxPlanDays) {
      return deadlineScreen({ ...s.draft, deadlineKind: deadline.kind }, 'too_long');
    }
    const next = changed(s, {
      pace: { mode: 'deadline', deadline },
      deadlineKind: deadline.kind,
    });
    return afterPace(userId, next, now);
  }

  async function setPerDay(
    userId: bigint,
    s: Session,
    value: number | null,
    now: Date,
  ): Promise<PlanScreen> {
    const total = s.draft.lineTo - s.draft.lineFrom + 1;
    if (value === null || value > total) {
      return { kind: 'per_day', token: s.draft.token, total, unit: unitOf(s.text), invalid: true };
    }
    return afterPace(userId, changed(s, { pace: { mode: 'per_day', unitsPerDay: value } }), now);
  }

  async function setStartDate(
    userId: bigint,
    s: Session,
    date: IsoDate | null,
    now: Date,
  ): Promise<PlanScreen> {
    const settings = await requireSettings(userId);
    const today = localDate(now, settings.timezone);
    if (!date || date < today || diffDays(today, date) > limits.maxStartDelayDays) {
      return startDateScreen(userId, s, now, true);
    }
    return review(userId, changed(s, { startDate: date }), now);
  }

  async function setSendTime(
    userId: bigint,
    s: Session,
    input: string,
    now: Date,
  ): Promise<PlanScreen> {
    const time = parseHHmm(input);
    if (!time) return { kind: 'send_time', token: s.draft.token, invalid: true };
    await users.updateSettings(userId, { dailySendTime: formatHHmm(time) });
    return review(userId, s, now);
  }

  async function start(userId: bigint, s: Session, now: Date): Promise<PlanScreen> {
    const { draft, text } = s;
    if (!draft.pace) return show(userId, 'pace', s);
    const summary = summarizePlan({ ...draft, pace: draft.pace }, limits);
    if (!summary.ok) return review(userId, s, now);
    const settings = await requireSettings(userId);
    const created = await plans.create({
      textId: text.id,
      userId,
      lineFrom: draft.lineFrom,
      lineTo: draft.lineTo,
      unitsPerDay: summary.unitsPerDay,
      paceMode: draft.pace.mode,
      startDate: draft.startDate,
      deadlineDate: summary.deadlineDate,
      deadlineInput:
        draft.pace.mode === 'deadline' ? encodeDeadlineInput(draft.pace.deadline) : null,
      restDays: summary.restDays,
      nextLine: draft.lineFrom,
      estimatedEndDate: summary.endDate,
    });
    await dialogs.clear(userId);
    if (!created) return { kind: 'already_planned', title: text.title };
    return {
      kind: 'started',
      title: text.title,
      unit: unitOf(text),
      summary,
      today: localDate(now, settings.timezone),
      sendTime: settings.dailySendTime,
    };
  }

  return {
    /** Начать диалог создания плана для сохранённого текста. */
    async begin(userId: bigint, textId: number, now: Date): Promise<PlanScreen> {
      const text = await readyText(userId, textId);
      if (!text) return { kind: 'stale' };
      if (await plans.findOpenByText(textId)) {
        return { kind: 'already_planned', title: text.title };
      }
      const settings = await requireSettings(userId);
      // Выходные обычно одни на все тексты — берём из последнего открытого плана.
      const previous = (await plans.listOpenByUser(userId)).at(-1);
      const draft: Draft = {
        token: newToken(),
        textId,
        lineFrom: 1,
        lineTo: text.totalLines,
        startDate: localDate(now, settings.timezone),
        restDays: previous?.restDays ?? [],
        restChosen: false,
        pace: null,
        deadlineKind: null,
        overloadAck: false,
      };
      return show(userId, 'scope', { step: 'scope', draft, text });
    },

    /** Нажатие кнопки диалога: `action` и `arg` — из callback_data. */
    async act(
      userId: bigint,
      token: string,
      action: string,
      arg: string,
      now: Date,
    ): Promise<PlanScreen> {
      const s = await load(userId, token);
      if (!s) return { kind: 'stale' };
      const { draft } = s;

      switch (action) {
        case 'all':
          return show(userId, 'pace', changed(s, { lineFrom: 1, lineTo: s.text.totalLines }));
        case 'range':
          return show(userId, 'scope_input', s);
        case 'later':
          await dialogs.clear(userId);
          return { kind: 'postponed' };
        case 'pace':
          if (arg === 'deadline') return show(userId, 'deadline_kind', s);
          if (arg === 'per_day') return show(userId, 'per_day', s);
          break;
        case 'dlk':
          if (isDeadlineKind(arg)) {
            return show(userId, 'deadline_input', { ...s, draft: { ...draft, deadlineKind: arg } });
          }
          break;
        case 'dlv': {
          const deadline = decodeDeadlineInput(arg);
          if (deadline) return setDeadline(userId, s, deadline, now);
          break;
        }
        case 'upd': {
          const value = parsePositive(arg);
          if (value) return setPerDay(userId, s, value, now);
          break;
        }
        case 'rest': {
          const day = parsePositive(arg);
          if (day && day <= 7) {
            return show(
              userId,
              'rest_days',
              changed(s, { restDays: toggleRestDay(draft.restDays, day) }),
            );
          }
          break;
        }
        case 'restok':
          return review(userId, changed(s, { restChosen: true }), now);
        case 'restnone':
          return review(userId, changed(s, { restDays: [], restChosen: true }), now);
        case 'start': {
          if (arg !== 'today' && arg !== 'tomorrow') break;
          const settings = await requireSettings(userId);
          const today = localDate(now, settings.timezone);
          return setStartDate(userId, s, arg === 'today' ? today : addDays(today, 1), now);
        }
        case 'time':
          return setSendTime(userId, s, arg, now);
        case 'edit':
          if (arg === 'pace') return show(userId, 'pace', s);
          if (arg === 'rest') return show(userId, 'rest_days', s);
          if (arg === 'start') return startDateScreen(userId, s, now);
          if (arg === 'time') return show(userId, 'send_time', s);
          break;
        case 'reduce':
          return show(userId, 'pace', s);
        case 'force':
          return review(userId, { ...s, draft: { ...draft, overloadAck: true } }, now);
        case 'go':
          if (s.step === 'confirm') return start(userId, s, now);
          return review(userId, s, now);
      }
      return { kind: 'stale' };
    },

    /** Ответ текстом на шаге ввода; null — пользователь не на таком шаге. */
    async handleText(userId: bigint, input: string, now: Date): Promise<PlanScreen | null> {
      const s = await load(userId);
      if (!s || !TEXT_STEPS.includes(s.step)) return null;
      const { draft, text } = s;

      switch (s.step) {
        case 'scope_input': {
          const range = parsePageRange(input, text.totalLines);
          if (!range) {
            return {
              kind: 'scope_input',
              token: draft.token,
              total: text.totalLines,
              unit: unitOf(text),
              invalid: true,
            };
          }
          return show(
            userId,
            'pace',
            changed(s, { lineFrom: range.pageFrom, lineTo: range.pageTo }),
          );
        }
        case 'deadline_input': {
          const kind = draft.deadlineKind ?? 'days';
          if (kind === 'date') {
            const date = parseUserDate(input);
            if (!date) return deadlineScreen(draft, 'format');
            return setDeadline(userId, s, { kind, date }, now);
          }
          const value = parsePositive(input);
          if (!value) return deadlineScreen(draft, 'format');
          return setDeadline(userId, s, { kind, value }, now);
        }
        case 'per_day':
          return setPerDay(userId, s, parsePositive(input), now);
        case 'start_date':
          return setStartDate(userId, s, parseUserDate(input), now);
        case 'send_time':
          return setSendTime(userId, s, input, now);
        default:
          return null;
      }
    },
  };
}

export type Plans = ReturnType<typeof createPlans>;
