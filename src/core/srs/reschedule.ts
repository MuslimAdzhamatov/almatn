import {
  nextSlot,
  planningDayOf,
  reviewChain,
  slotOn,
  mainSlotOn,
  type RepStage,
  type Slot,
  type SlotSettings,
} from './slots.js';

// Смена часового пояса или времени (CLAUDE.md, разделы 5.4 и 5.5): anchorAt переносится на тот же вид
// слота тех же плановых суток по новым настройкам, будущие неподтверждённые этапы считаются заново.

const TOLERANCE_MS = 60 * 1000;

/** Каким слотом был anchorAt по прежним настройкам. */
export function anchorSlotOf(anchorAt: Date, s: SlotSettings): Slot {
  const day = planningDayOf(anchorAt, s);
  const main = mainSlotOn(day, s);
  const kind = Math.abs(anchorAt.getTime() - main.getTime()) < TOLERANCE_MS ? 'main' : 'second';
  return { at: kind === 'main' ? main : slotOn(day, 'second', s).at, kind, day };
}

export interface PendingStage {
  id: number;
  stage: RepStage;
}

export interface RescheduledChain {
  anchorAt: Date;
  updates: { id: number; dueAt: Date }[];
}

/**
 * Новый anchorAt и сроки этапов. Передаются только этапы, которые ещё не наступили и не отправлены;
 * срок, оказавшийся в прошлом по новым настройкам, переносится на ближайший будущий слот.
 */
export function rescheduleChain(
  anchorAt: Date,
  before: SlotSettings,
  after: SlotSettings,
  now: Date,
  stages: readonly PendingStage[],
): RescheduledChain {
  const old = anchorSlotOf(anchorAt, before);
  const anchor = slotOn(old.day, old.kind, after);
  const chain = new Map(reviewChain(anchor, now, after).map((c) => [c.stage, c.dueAt]));
  const soon = nextSlot(now, after).at;
  return {
    anchorAt: anchor.at,
    updates: stages.map(({ id, stage }) => {
      const dueAt = chain.get(stage)!;
      return { id, dueAt: dueAt > now ? dueAt : soon };
    }),
  };
}
