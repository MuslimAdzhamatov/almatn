import { addDays, localDate, type IsoDate } from '../core/plan/dates.js';
import { cleanStreak } from '../core/plan/progress.js';
import type { MergedRange, UnitRange } from '../core/srs/ranges.js';
import { mainSlotOn, planningDayOf } from '../core/srs/slots.js';
import { isPaused, type Learning, type NextPortion } from './learning.js';
import type {
  FileStore,
  LearnerSettings,
  LearningStore,
  LibraryStore,
  LibraryText,
  PlanRecord,
  UnitLabel,
} from './ports.js';
import type { Reviews } from './reviews.js';
import { mergedRanges } from './units.js';

// /texts, /progress, /today и удаление данных (CLAUDE.md, раздел 5.5).

export interface LibraryDeps {
  library: LibraryStore;
  store: Pick<
    LearningStore,
    'learner' | 'countUnits' | 'lastPortion' | 'unlearnedPortion' | 'textReviews' | 'unitRows'
  >;
  learning: Pick<Learning, 'preview'>;
  reviews: Pick<Reviews, 'sendDebtNow'>;
  files: Pick<FileStore, 'removeText'>;
}

export interface PlanProgress {
  id: number;
  status: PlanRecord['status'];
  paceMode: PlanRecord['paceMode'];
  unitsPerDay: number;
  deadlineDate: IsoDate | null;
  estimatedEndDate: IsoDate | null;
  learnedUnits: number;
  totalUnits: number;
  percent: number;
  reviewsDone: number;
  reviewsMissed: number;
  /** Плановых суток подряд без долгов. */
  streak: number;
  /** Дата последнего ещё не сделанного повтора. */
  lastReviewDate: IsoDate | null;
}

export interface TextProgress extends UnitLabel {
  textId: number;
  title: string;
  totalLines: number;
  plan: PlanProgress | null;
}

export type TodayPortion =
  | { kind: 'issued'; lineStart: number; lineEnd: number; learned: boolean }
  | Exclude<NextPortion, { kind: 'sent' | 'retry' }>
  | { kind: 'soon' };

export interface TodayText extends UnitLabel {
  textId: number;
  title: string;
  /** null — заучивание по плану закончено, остались повторы. */
  portion: TodayPortion | null;
  /** Наступившие и не отмеченные повторы. */
  owed: MergedRange[];
  /** Невыученная порция. */
  unlearned: UnitRange | null;
  /** Повторы, которые ещё придут в эти плановые сутки. */
  later: MergedRange[];
}

export type LibraryScreen =
  | { kind: 'texts'; texts: TextProgress[] }
  | { kind: 'card'; text: TextProgress }
  | { kind: 'progress'; texts: TextProgress[] }
  | { kind: 'today'; texts: TodayText[]; paused: { until: Date | null } | null; timezone: string }
  | { kind: 'pick'; purpose: 'pace' | 'delete'; texts: { id: number; title: string }[] }
  | { kind: 'delete_confirm'; textId: number; title: string }
  | { kind: 'deleted'; title: string }
  | { kind: 'wipe_confirm'; step: 1 | 2 }
  | { kind: 'wiped' }
  | { kind: 'debt_sent'; messages: number }
  | { kind: 'no_texts' }
  | { kind: 'stale' };

const unitOf = (text: LibraryText): UnitLabel => ({
  unitName: text.unitName,
  strategy: text.parseStrategy,
});

export function createLibrary({ library, store, learning, reviews, files }: LibraryDeps) {
  async function planProgress(
    text: LibraryText,
    plan: PlanRecord,
    user: LearnerSettings,
    now: Date,
  ): Promise<PlanProgress> {
    const portions = await library.portions(plan.id);
    const planReviews = await library.reviews(plan.id);
    let learnedUnits = 0;
    for (const p of portions) {
      if (p.status !== 'sent')
        learnedUnits += await store.countUnits(text.id, p.lineStart, p.lineEnd);
    }
    const totalUnits = await store.countUnits(text.id, plan.lineFrom, plan.lineTo);
    const duties = [
      ...portions.map((p) => ({ dueAt: p.sentAt, doneAt: p.learnedAt })),
      ...planReviews.map((r) => ({
        dueAt: r.dueAt,
        doneAt: r.status === 'confirmed' ? (r.confirmedAt ?? r.dueAt) : null,
      })),
    ];
    const open = planReviews.filter((r) => r.status !== 'confirmed');
    const last = open.at(-1);
    return {
      id: plan.id,
      status: plan.status,
      paceMode: plan.paceMode,
      unitsPerDay: plan.unitsPerDay,
      deadlineDate: plan.deadlineDate,
      estimatedEndDate: plan.estimatedEndDate,
      learnedUnits,
      totalUnits,
      percent: totalUnits > 0 ? Math.floor((learnedUnits * 100) / totalUnits) : 0,
      reviewsDone: planReviews.length - open.length,
      reviewsMissed: planReviews.filter((r) => r.status === 'missed').length,
      streak: cleanStreak(duties, now, user, plan.startDate),
      lastReviewDate: last ? localDate(last.dueAt, user.timezone) : null,
    };
  }

  async function progressOf(texts: LibraryText[], user: LearnerSettings, now: Date) {
    const result: TextProgress[] = [];
    for (const text of texts) {
      result.push({
        ...unitOf(text),
        textId: text.id,
        title: text.title,
        totalLines: text.totalLines,
        plan: text.plan && (await planProgress(text, text.plan, user, now)),
      });
    }
    return result;
  }

  async function ownText(userId: bigint, textId: number) {
    return (await library.listTexts(userId)).find((t) => t.id === textId) ?? null;
  }

  async function todayOf(text: LibraryText, plan: PlanRecord, user: LearnerSettings, now: Date) {
    const day = planningDayOf(now, user);
    const nextMain = mainSlotOn(addDays(day, 1), user);
    const rows = await store.textReviews(text.id);
    const unlearned = plan.status === 'active' ? await store.unlearnedPortion(plan.id) : null;
    const owed = rows.filter((r) => r.dueAt <= now);
    const later = rows.filter((r) => r.dueAt > now && r.dueAt < nextMain);

    let portion: TodayPortion | null = null;
    if (plan.status === 'active') {
      const last = await store.lastPortion(plan.id);
      if (last && planningDayOf(last.sentAt, user) === day) {
        portion = {
          kind: 'issued',
          lineStart: last.lineStart,
          lineEnd: last.lineEnd,
          learned: last.status !== 'sent',
        };
      } else {
        const next = await learning.preview(plan.id, now);
        portion = next.kind === 'sent' || next.kind === 'retry' ? { kind: 'soon' } : next;
      }
    }
    return {
      ...unitOf(text),
      textId: text.id,
      title: text.title,
      portion,
      owed: await mergedRanges(store, text.id, owed),
      unlearned:
        unlearned && unlearned.sentAt < mainSlotOn(day, user)
          ? { lineStart: unlearned.lineStart, lineEnd: unlearned.lineEnd }
          : null,
      later: await mergedRanges(store, text.id, later),
    };
  }

  return {
    async texts(userId: bigint, now: Date): Promise<LibraryScreen> {
      const user = await store.learner(userId);
      if (!user) return { kind: 'stale' };
      const texts = await library.listTexts(userId);
      if (texts.length === 0) return { kind: 'no_texts' };
      return { kind: 'texts', texts: await progressOf(texts, user, now) };
    },

    async progress(userId: bigint, now: Date): Promise<LibraryScreen> {
      const user = await store.learner(userId);
      if (!user) return { kind: 'stale' };
      const texts = (await library.listTexts(userId)).filter((t) => t.plan !== null);
      if (texts.length === 0) return { kind: 'no_texts' };
      return { kind: 'progress', texts: await progressOf(texts, user, now) };
    },

    async card(userId: bigint, textId: number, now: Date): Promise<LibraryScreen> {
      const user = await store.learner(userId);
      const text = await ownText(userId, textId);
      if (!user || !text) return { kind: 'stale' };
      const [progress] = await progressOf([text], user, now);
      return { kind: 'card', text: progress! };
    },

    async today(userId: bigint, now: Date): Promise<LibraryScreen> {
      const user = await store.learner(userId);
      if (!user) return { kind: 'stale' };
      const texts: TodayText[] = [];
      for (const text of await library.listTexts(userId)) {
        const plan = text.plan;
        if (!plan || plan.status === 'completed') continue;
        texts.push(await todayOf(text, plan, user, now));
      }
      if (texts.length === 0) return { kind: 'no_texts' };
      return {
        kind: 'today',
        texts,
        paused: isPaused(user, now) ? { until: user.pausedUntil } : null,
        timezone: user.timezone,
      };
    },

    /** «Прислать долг сейчас» из /today. */
    async sendDebt(userId: bigint, textId: number, now: Date): Promise<LibraryScreen> {
      const user = await store.learner(userId);
      if (!user || !(await ownText(userId, textId))) return { kind: 'stale' };
      if (isPaused(user, now)) return { kind: 'stale' };
      return { kind: 'debt_sent', messages: await reviews.sendDebtNow(userId, now, textId) };
    },

    /** Выбор текста: для смены темпа — только идущие планы. */
    async pick(userId: bigint, purpose: 'pace' | 'delete'): Promise<LibraryScreen> {
      const texts = (await library.listTexts(userId)).filter(
        (t) => purpose === 'delete' || t.plan?.status === 'active',
      );
      if (texts.length === 0) return { kind: 'no_texts' };
      return {
        kind: 'pick',
        purpose,
        texts: texts.map((t) => ({ id: purpose === 'pace' ? t.plan!.id : t.id, title: t.title })),
      };
    },

    async askDelete(userId: bigint, textId: number): Promise<LibraryScreen> {
      const text = await ownText(userId, textId);
      return text ? { kind: 'delete_confirm', textId, title: text.title } : { kind: 'stale' };
    },

    async deleteText(userId: bigint, textId: number): Promise<LibraryScreen> {
      const text = await ownText(userId, textId);
      if (!text || !(await library.deleteText(userId, textId))) return { kind: 'stale' };
      await files.removeText(textId);
      return { kind: 'deleted', title: text.title };
    },

    askWipe: (step: 1 | 2): LibraryScreen => ({ kind: 'wipe_confirm', step }),

    /** Удалить все данные пользователя: база, PDF и картинки. */
    async wipe(userId: bigint): Promise<LibraryScreen> {
      for (const textId of await library.deleteUser(userId)) await files.removeText(textId);
      return { kind: 'wiped' };
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;
