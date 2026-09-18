import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import type { LibraryScreen, TextProgress, TodayText } from '../../../app/library.js';
import type { UnitLabel } from '../../../app/ports.js';
import { formatUserDate } from '../../../core/plan/dates.js';
import { texts, unitCount } from '../texts.js';
import { whenText } from './learning.js';
import type { RenderedMessage } from './onboarding.js';
import { rangesText } from './reviews.js';

// /texts, /progress, /today, удаление (CLAUDE.md, раздел 5.5).

const t = texts.library;
const b = t.buttons;

/** callback_data: `lb:<действие>[:<id>]`. */
export const LIBRARY_CALLBACK = /^lb:(\w+)(?::(\d+))?$/;

const count = (n: number, unit: UnitLabel) => unitCount(n, unit.strategy, unit.unitName);
const MAX_BUTTON_TITLE = 32;
const short = (title: string) =>
  title.length > MAX_BUTTON_TITLE ? `${title.slice(0, MAX_BUTTON_TITLE - 1)}…` : title;

function statusLine(text: TextProgress): string {
  const { plan } = text;
  if (!plan) return t.noPlan;
  if (plan.status === 'completed') return t.planDone;
  return t.percent(plan.percent, String(plan.learnedUnits), count(plan.totalUnits, text));
}

/** Прогресс одного текста — для /progress и карточки в /texts. */
export function progressLines(text: TextProgress): string[] {
  const { plan } = text;
  const lines = [t.textTitle(text.title)];
  if (!plan) return [...lines, t.noPlanLine];
  lines.push(t.learned(String(plan.learnedUnits), count(plan.totalUnits, text), plan.percent));
  if (plan.knownUnits > 0) lines.push(t.known(count(plan.knownUnits, text)));
  if (plan.status === 'completed') return [...lines, t.completed];
  if (plan.status === 'learning_done') {
    lines.push(t.learningDone(plan.lastReviewDate && formatUserDate(plan.lastReviewDate)));
  } else {
    const perDay = count(plan.unitsPerDay, text);
    lines.push(
      plan.paceMode === 'deadline' && plan.deadlineDate
        ? t.paceDeadline(perDay, formatUserDate(plan.deadlineDate))
        : t.pacePerDay(perDay),
    );
    if (plan.estimatedEndDate) lines.push(t.endDate(formatUserDate(plan.estimatedEndDate)));
  }
  lines.push(t.reviews(plan.reviewsDone, plan.reviewsMissed), t.streak(plan.streak));
  return lines;
}

function todayLines(text: TodayText, timezone: string, now: Date): string[] {
  const lines = [t.textTitle(text.title)];
  const p = text.portion;
  if (p) {
    switch (p.kind) {
      case 'issued':
        lines.push(t.portionIssued(rangesText(text, [p]), p.learned));
        break;
      case 'at':
        lines.push(t.portionAt(whenText(p.at, timezone, now)));
        break;
      case 'debt':
        lines.push(t.portionDebt);
        break;
      case 'done':
        lines.push(t.portionDone);
        break;
      case 'paused':
        lines.push(t.portionPaused);
        break;
      case 'soon':
        lines.push(t.portionSoon);
        break;
    }
  }
  const owed = [
    ...(text.owed.length > 0 ? [t.owedRepeat(rangesText(text, text.owed))] : []),
    ...(text.unlearned ? [t.owedLearn(rangesText(text, [text.unlearned]))] : []),
  ];
  lines.push(owed.length > 0 ? t.owed(owed.join('; ')) : t.clean);
  if (text.later.length > 0) lines.push(t.later(rangesText(text, text.later)));
  return lines;
}

const hasDebt = (text: TodayText) => text.owed.length > 0 || text.unlearned !== null;

export function renderLibrary(
  screen: Exclude<LibraryScreen, { kind: 'stale' | 'debt_sent' }>,
  now = new Date(),
): RenderedMessage {
  switch (screen.kind) {
    case 'no_texts':
      return { text: t.noTexts };
    case 'texts': {
      const keyboard = new InlineKeyboard();
      for (const text of screen.texts)
        keyboard.text(`📖 ${short(text.title)}`, `lb:card:${text.textId}`).row();
      keyboard.text(b.upload, 'lb:upload');
      return {
        text: [
          t.listTitle,
          ...screen.texts.map((text, i) => t.listItem(i + 1, text.title, statusLine(text))),
        ].join('\n'),
        keyboard,
      };
    }
    case 'card': {
      const { text } = screen;
      const keyboard = new InlineKeyboard();
      if (!text.plan || text.plan.status === 'completed') {
        keyboard.text(b.plan, `lb:plan:${text.textId}`).row();
      } else if (text.plan.status === 'active') {
        keyboard.text(b.pace, `pe:${text.plan.id}:open`).row();
      }
      keyboard.text(b.delete, `lb:del:${text.textId}`).row().text(b.toList, 'lb:list');
      return { text: progressLines(text).join('\n'), keyboard };
    }
    case 'progress':
      return {
        text: [
          t.progressTitle,
          ...screen.texts.flatMap((text) => ['', ...progressLines(text)]),
        ].join('\n'),
      };
    case 'today': {
      const lines: string[] = [t.todayTitle];
      if (screen.paused) {
        const { until } = screen.paused;
        lines.push(
          until
            ? t.pausedUntil(
                DateTime.fromJSDate(until, { zone: screen.timezone }).toFormat('HH:mm dd.MM.yyyy'),
              )
            : t.pausedManual,
        );
      }
      for (const text of screen.texts) lines.push('', ...todayLines(text, screen.timezone, now));
      const keyboard = new InlineKeyboard();
      if (!screen.paused) {
        for (const text of screen.texts.filter(hasDebt)) {
          keyboard.text(b.sendDebt(short(text.title)), `lb:debt:${text.textId}`).row();
        }
      }
      return { text: lines.join('\n'), keyboard };
    }
    case 'pick': {
      const keyboard = new InlineKeyboard();
      for (const text of screen.texts) {
        const data = screen.purpose === 'pace' ? `pe:${text.id}:open` : `lb:del:${text.id}`;
        keyboard.text(short(text.title), data).row();
      }
      keyboard.text(texts.settings.buttons.back, 'se:menu');
      return { text: screen.purpose === 'pace' ? t.pickPace : t.pickDelete, keyboard };
    }
    case 'delete_confirm':
      return {
        text: t.deleteQuestion(screen.title),
        keyboard: new InlineKeyboard()
          .text(b.deleteConfirm, `lb:delok:${screen.textId}`)
          .text(b.cancel, 'lb:list'),
      };
    case 'deleted':
      return { text: t.deleted(screen.title) };
    case 'wipe_confirm':
      return screen.step === 1
        ? {
            text: t.wipe1,
            keyboard: new InlineKeyboard().text(b.wipeYes, 'lb:wipe2').text(b.cancel, 'se:menu'),
          }
        : {
            text: t.wipe2,
            keyboard: new InlineKeyboard().text(b.wipeFinal, 'lb:wipeok').text(b.cancel, 'se:menu'),
          };
    case 'wiped':
      return { text: t.wiped };
  }
}
