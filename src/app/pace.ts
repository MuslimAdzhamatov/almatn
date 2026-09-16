import { checkPace, type PaceCheck } from '../core/plan/catchup.js';
import { planningDayOf } from '../core/srs/slots.js';
import type { LearningStore, PlanContext, UnitLabel } from './ports.js';

// «Успеть к сроку» / «Сдвинуть срок» после закрытия долга (CLAUDE.md, раздел 5.2).

export interface PaceNotice extends UnitLabel {
  planId: number;
  title: string;
  unitsPerDay: number;
  check: Extract<PaceCheck, { kind: 'shifted' | 'behind' }>;
}

export type PaceChoice = 'catch_up' | 'shift';

export type PaceChoiceResult =
  | { kind: 'caught_up'; title: string; unit: UnitLabel; unitsPerDay: number; endDate: string }
  | { kind: 'shifted'; title: string; endDate: string }
  | { kind: 'stale' };

type PaceStore = Pick<LearningStore, 'planContext' | 'countUnits' | 'updatePlan'>;

export function createPace(store: PaceStore) {
  async function evaluate(ctx: PlanContext, now: Date): Promise<PaceCheck | null> {
    const { plan, text, user } = ctx;
    if (plan.status !== 'active') return null;
    return checkPace({
      today: planningDayOf(now, user),
      remainingUnits: await store.countUnits(text.id, plan.nextLine, plan.lineTo),
      unitsPerDay: plan.unitsPerDay,
      restDays: plan.restDays,
      startDate: plan.startDate,
      paceMode: plan.paceMode,
      deadlineDate: plan.deadlineDate,
      estimatedEndDate: plan.estimatedEndDate,
    });
  }

  return {
    /**
     * Проверка после закрытия долга: сдвиг в пределах срока записывается молча,
     * сдвиг в режиме «по количеству в день» — с сообщением, отставание от срока — выбор.
     */
    async check(planId: number, now: Date): Promise<PaceNotice | null> {
      const ctx = await store.planContext(planId);
      if (!ctx) return null;
      const check = await evaluate(ctx, now);
      if (!check) return null;
      if (check.kind !== 'behind' && check.endDate !== ctx.plan.estimatedEndDate) {
        await store.updatePlan(planId, { estimatedEndDate: check.endDate });
      }
      if (check.kind === 'on_track') return null;
      return {
        unitName: ctx.text.unitName,
        strategy: ctx.text.parseStrategy,
        planId,
        title: ctx.text.title,
        unitsPerDay: ctx.plan.unitsPerDay,
        check,
      };
    },

    /** Ответ на выбор; пересчёт повторяется на момент нажатия. */
    async choose(
      userId: bigint,
      planId: number,
      choice: PaceChoice,
      now: Date,
    ): Promise<PaceChoiceResult> {
      const ctx = await store.planContext(planId);
      if (!ctx || ctx.user.userId !== userId) return { kind: 'stale' };
      const check = await evaluate(ctx, now);
      if (check?.kind !== 'behind') return { kind: 'stale' };
      const title = ctx.text.title;
      if (choice === 'shift') {
        await store.updatePlan(planId, {
          estimatedEndDate: check.shiftEndDate,
          deadlineDate: check.shiftEndDate,
        });
        return { kind: 'shifted', title, endDate: check.shiftEndDate };
      }
      if (check.catchUpUnitsPerDay === null || check.catchUpEndDate === null) {
        return { kind: 'stale' };
      }
      await store.updatePlan(planId, {
        unitsPerDay: check.catchUpUnitsPerDay,
        estimatedEndDate: check.catchUpEndDate,
      });
      return {
        kind: 'caught_up',
        title,
        unit: { unitName: ctx.text.unitName, strategy: ctx.text.parseStrategy },
        unitsPerDay: check.catchUpUnitsPerDay,
        endDate: check.catchUpEndDate,
      };
    },
  };
}

export type Pace = ReturnType<typeof createPace>;
