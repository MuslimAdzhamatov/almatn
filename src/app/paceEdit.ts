import { addDays, diffDays, maxDate, parseUserDate, type IsoDate } from '../core/plan/dates.js';
import {
  DAYS_IN_MONTH,
  encodeDeadlineInput,
  type DeadlineInput,
  type PaceInput,
} from '../core/plan/pace.js';
import { summarizePlan, type PlanSummary } from '../core/plan/summary.js';
import { planningDayOf } from '../core/srs/slots.js';
import type { PlanLimits } from './plans.js';
import type { DialogStore, LearningStore, PlanContext, UnitLabel } from './ports.js';

// Смена темпа по тексту (CLAUDE.md, раздел 5.5): «по сроку» ↔ «по количеству в день».
// Пересчитываются только ещё не выданные единицы; выданные порции и их повторы не меняются.

const FLOW = 'pace_edit';

type DeadlineKind = DeadlineInput['kind'];
type Step = 'per_day' | 'deadline_input' | 'preview';

interface Data {
  planId: number;
  deadlineKind?: DeadlineKind;
  pace?: PaceInput;
}

export type PaceDeadlineError = 'format' | 'too_long' | 'deadline_before_start' | 'no_working_days';

export interface PaceTarget extends UnitLabel {
  planId: number;
  title: string;
}

export type PaceEditScreen =
  | {
      kind: 'mode';
      target: PaceTarget;
      paceMode: 'deadline' | 'per_day';
      unitsPerDay: number;
      deadlineDate: IsoDate | null;
      remaining: number;
    }
  | { kind: 'per_day'; target: PaceTarget; remaining: number; invalid: boolean }
  | { kind: 'deadline_kind'; target: PaceTarget; from: IsoDate }
  | {
      kind: 'deadline_input';
      target: PaceTarget;
      input: DeadlineKind;
      from: IsoDate;
      maxDays: number;
      error: PaceDeadlineError | null;
    }
  | {
      kind: 'preview';
      target: PaceTarget;
      from: IsoDate;
      summary: PlanSummary;
      limits: PlanLimits;
    }
  | { kind: 'saved'; target: PaceTarget; unitsPerDay: number; endDate: IsoDate }
  | { kind: 'nothing_left'; title: string }
  | { kind: 'stale' };

export interface PaceEditDeps {
  store: Pick<LearningStore, 'planContext' | 'lastPortion' | 'updatePlan'>;
  dialogs: DialogStore;
  limits: PlanLimits;
}

const isDeadlineKind = (value: string): value is DeadlineKind =>
  value === 'days' || value === 'months' || value === 'date';

const parsePositive = (input: string): number | null => {
  const value = Number(input.trim());
  return Number.isInteger(value) && value >= 1 ? value : null;
};

export function createPaceEdit({ store, dialogs, limits }: PaceEditDeps) {
  interface Session {
    ctx: PlanContext;
    target: PaceTarget;
    from: IsoDate;
    remaining: number;
  }

  /** План пользователя, по которому ещё идёт заучивание. */
  async function session(userId: bigint, planId: number, now: Date): Promise<Session | null> {
    const ctx = await store.planContext(planId);
    if (!ctx || ctx.user.userId !== userId || ctx.plan.status !== 'active') return null;
    const { plan, user, text } = ctx;
    const day = planningDayOf(now, user);
    const last = await store.lastPortion(plan.id);
    // Порция этих суток уже выдана — новый темп начинается со следующих.
    const issuedToday = last !== null && planningDayOf(last.sentAt, user) === day;
    return {
      ctx,
      target: {
        planId,
        title: text.title,
        unitName: text.unitName,
        strategy: text.parseStrategy,
      },
      from: maxDate(issuedToday ? addDays(day, 1) : day, plan.startDate),
      remaining: plan.lineTo - plan.nextLine + 1,
    };
  }

  async function step(userId: bigint, name: Step, data: Data) {
    await dialogs.set(userId, { flow: FLOW, step: name, data: { ...data } });
  }

  function deadlineScreen(s: Session, input: DeadlineKind, error: PaceDeadlineError | null) {
    return {
      kind: 'deadline_input',
      target: s.target,
      input,
      from: s.from,
      maxDays: limits.maxPlanDays,
      error,
    } as const;
  }

  async function preview(userId: bigint, s: Session, pace: PaceInput): Promise<PaceEditScreen> {
    const { plan } = s.ctx;
    if (pace.mode === 'deadline') {
      const days =
        pace.deadline.kind === 'days'
          ? pace.deadline.value
          : pace.deadline.kind === 'months'
            ? pace.deadline.value * DAYS_IN_MONTH
            : diffDays(s.from, pace.deadline.date) + 1;
      if (days > limits.maxPlanDays) {
        await step(userId, 'deadline_input', { planId: plan.id, deadlineKind: pace.deadline.kind });
        return deadlineScreen(s, pace.deadline.kind, 'too_long');
      }
    }
    const summary = summarizePlan(
      {
        lineFrom: plan.nextLine,
        lineTo: plan.lineTo,
        startDate: s.from,
        restDays: plan.restDays,
        pace,
      },
      limits,
    );
    if (!summary.ok) {
      const kind = pace.mode === 'deadline' ? pace.deadline.kind : 'days';
      await step(userId, 'deadline_input', { planId: plan.id, deadlineKind: kind });
      return deadlineScreen(s, kind, summary.reason);
    }
    await step(userId, 'preview', { planId: plan.id, pace });
    return { kind: 'preview', target: s.target, from: s.from, summary, limits };
  }

  async function setPerDay(userId: bigint, s: Session, value: number | null) {
    if (value === null || value > s.remaining) {
      await step(userId, 'per_day', { planId: s.target.planId });
      return {
        kind: 'per_day',
        target: s.target,
        remaining: s.remaining,
        invalid: true,
      } as const;
    }
    return preview(userId, s, { mode: 'per_day', unitsPerDay: value });
  }

  async function save(userId: bigint, s: Session, pace: PaceInput): Promise<PaceEditScreen> {
    const { plan } = s.ctx;
    const summary = summarizePlan(
      {
        lineFrom: plan.nextLine,
        lineTo: plan.lineTo,
        startDate: s.from,
        restDays: plan.restDays,
        pace,
      },
      limits,
    );
    if (!summary.ok) return { kind: 'stale' };
    await store.updatePlan(plan.id, {
      paceMode: pace.mode,
      unitsPerDay: summary.unitsPerDay,
      deadlineDate: summary.deadlineDate,
      deadlineInput: pace.mode === 'deadline' ? encodeDeadlineInput(pace.deadline) : null,
      estimatedEndDate: summary.endDate,
    });
    await dialogs.clear(userId);
    return {
      kind: 'saved',
      target: s.target,
      unitsPerDay: summary.unitsPerDay,
      endDate: summary.endDate,
    };
  }

  return {
    /** Начать смену темпа плана. */
    async open(userId: bigint, planId: number, now: Date): Promise<PaceEditScreen> {
      const s = await session(userId, planId, now);
      if (!s) return { kind: 'stale' };
      await dialogs.clear(userId);
      if (s.remaining < 1) return { kind: 'nothing_left', title: s.target.title };
      const { plan } = s.ctx;
      return {
        kind: 'mode',
        target: s.target,
        paceMode: plan.paceMode,
        unitsPerDay: plan.unitsPerDay,
        deadlineDate: plan.deadlineDate,
        remaining: s.remaining,
      };
    },

    /** Кнопка диалога: `pe:<план>:<действие>[:<значение>]`. */
    async act(
      userId: bigint,
      planId: number,
      action: string,
      arg: string,
      now: Date,
    ): Promise<PaceEditScreen> {
      const s = await session(userId, planId, now);
      if (!s || s.remaining < 1) return { kind: 'stale' };
      switch (action) {
        case 'mode':
          if (arg === 'per_day') {
            await step(userId, 'per_day', { planId });
            return { kind: 'per_day', target: s.target, remaining: s.remaining, invalid: false };
          }
          if (arg === 'deadline') {
            await dialogs.clear(userId);
            return { kind: 'deadline_kind', target: s.target, from: s.from };
          }
          break;
        case 'upd':
          return setPerDay(userId, s, parsePositive(arg));
        case 'dlk':
          if (!isDeadlineKind(arg)) break;
          await step(userId, 'deadline_input', { planId, deadlineKind: arg });
          return deadlineScreen(s, arg, null);
        case 'dlv': {
          // «days.30», «months.3» — кнопки-подсказки срока.
          const [kind, raw] = arg.split('.');
          const value = parsePositive(raw ?? '');
          if ((kind !== 'days' && kind !== 'months') || !value) break;
          return preview(userId, s, { mode: 'deadline', deadline: { kind, value } });
        }
        case 'save': {
          const dialog = await dialogs.get(userId);
          const data = dialog?.flow === FLOW ? (dialog.data as unknown as Data) : null;
          if (dialog?.step !== 'preview' || data?.planId !== planId || !data.pace) break;
          return save(userId, s, data.pace);
        }
      }
      return { kind: 'stale' };
    },

    /** Ответ текстом: число в день или срок; null — пользователь не в этом диалоге. */
    async handleText(userId: bigint, input: string, now: Date): Promise<PaceEditScreen | null> {
      const dialog = await dialogs.get(userId);
      if (dialog?.flow !== FLOW) return null;
      // Данные диалога записывает только этот сценарий.
      const data = dialog.data as unknown as Data;
      const s = await session(userId, data.planId, now);
      if (!s) {
        await dialogs.clear(userId);
        return { kind: 'stale' };
      }
      if (dialog.step === 'per_day') return setPerDay(userId, s, parsePositive(input));
      if (dialog.step !== 'deadline_input') return null;
      const kind = data.deadlineKind ?? 'days';
      if (kind === 'date') {
        const date = parseUserDate(input);
        if (!date) return deadlineScreen(s, kind, 'format');
        return preview(userId, s, { mode: 'deadline', deadline: { kind, date } });
      }
      const value = parsePositive(input);
      if (!value) return deadlineScreen(s, kind, 'format');
      return preview(userId, s, { mode: 'deadline', deadline: { kind, value } });
    },
  };
}

export type PaceEdit = ReturnType<typeof createPaceEdit>;
