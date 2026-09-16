import { InlineKeyboard } from 'grammy';
import type { PaceEditScreen } from '../../../app/paceEdit.js';
import type { UnitLabel } from '../../../app/ports.js';
import { formatUserDate } from '../../../core/plan/dates.js';
import { texts, unitCount, unitCountGenitive, unitNounMany } from '../texts.js';
import type { RenderedMessage } from './onboarding.js';

// Смена темпа по тексту (CLAUDE.md, раздел 5.5).

const t = texts.paceEdit;
const p = texts.plan;

/** callback_data: `pe:<id плана>:<действие>[:<значение>]`. */
export const PACE_EDIT_CALLBACK = /^pe:(\d+):(\w+)(?::([\w.]+))?$/;

const count = (n: number, unit: UnitLabel) => unitCount(n, unit.strategy, unit.unitName);
const cb = (planId: number, action: string, arg?: string | number) =>
  ['pe', planId, action, ...(arg === undefined ? [] : [arg])].join(':');

export function renderPaceEdit(
  screen: Exclude<PaceEditScreen, { kind: 'stale' }>,
): RenderedMessage {
  switch (screen.kind) {
    case 'nothing_left':
      return { text: t.nothingLeft(screen.title) };
    case 'mode': {
      const { target } = screen;
      const current = t.current(
        count(screen.unitsPerDay, target),
        screen.paceMode === 'deadline' && screen.deadlineDate
          ? formatUserDate(screen.deadlineDate)
          : null,
      );
      return {
        text: t.mode(target.title, current, count(screen.remaining, target)),
        keyboard: new InlineKeyboard()
          .text(p.buttons.byDeadline, cb(target.planId, 'mode', 'deadline'))
          .text(p.buttons.perDay, cb(target.planId, 'mode', 'per_day'))
          .row()
          .text(texts.library.buttons.cancel, 'lb:list'),
      };
    }
    case 'per_day': {
      const { target } = screen;
      const keyboard = new InlineKeyboard();
      for (const n of [2, 3, 5].filter((n) => n <= screen.remaining)) {
        keyboard.text(String(n), cb(target.planId, 'upd', n));
      }
      return {
        text: p.perDay(
          unitNounMany(target.strategy, target.unitName),
          screen.remaining,
          screen.invalid,
        ),
        keyboard: keyboard.row().text(texts.library.buttons.cancel, 'lb:list'),
      };
    }
    case 'deadline_kind': {
      const id = screen.target.planId;
      return {
        text: t.deadlineKind(formatUserDate(screen.from)),
        keyboard: new InlineKeyboard()
          .text(p.buttons.days, cb(id, 'dlk', 'days'))
          .text(p.buttons.months, cb(id, 'dlk', 'months'))
          .text(p.buttons.date, cb(id, 'dlk', 'date'))
          .row()
          .text(texts.library.buttons.cancel, 'lb:list'),
      };
    }
    case 'deadline_input': {
      const id = screen.target.planId;
      const from = formatUserDate(screen.from);
      const keyboard = new InlineKeyboard();
      let question: string;
      if (screen.input === 'days') {
        question = t.deadlineDays(from, screen.maxDays);
        for (const n of [7, 14, 30, 60, 90]) keyboard.text(String(n), cb(id, 'dlv', `days.${n}`));
      } else if (screen.input === 'months') {
        question = t.deadlineMonths(from);
        for (const n of [1, 2, 3, 6, 12]) keyboard.text(String(n), cb(id, 'dlv', `months.${n}`));
      } else {
        question = t.deadlineDate(from);
      }
      const errors = p.deadlineErrors;
      const error =
        screen.error === 'too_long'
          ? errors.too_long(screen.maxDays)
          : screen.error === 'deadline_before_start'
            ? errors.deadline_before_start(from)
            : screen.error
              ? errors[screen.error]
              : null;
      return {
        text: error ? `${error}\n\n${question}` : question,
        keyboard: keyboard.row().text(texts.library.buttons.cancel, 'lb:list'),
      };
    }
    case 'preview': {
      const { target, summary, limits } = screen;
      const perDay = count(summary.unitsPerDay, target);
      const { typicalLow, typicalHigh, peak } = summary.load;
      const typical =
        typicalLow === typicalHigh
          ? `~${count(typicalHigh, target)}`
          : `${typicalLow}–${count(typicalHigh, target)}`;
      const lines = [
        t.preview(
          target.title,
          perDay,
          formatUserDate(summary.endDate),
          formatUserDate(summary.lastReviewDate),
        ),
        p.load(typical, peak),
      ];
      if (summary.unitsPerDay > limits.maxUnitsPerDay || peak > limits.maxPeakReview) {
        lines.push(
          '',
          p.overload(perDay, unitCountGenitive(peak, target.strategy, target.unitName)),
        );
      }
      return {
        text: lines.join('\n'),
        keyboard: new InlineKeyboard()
          .text(t.buttons.save, cb(target.planId, 'save'))
          .text(t.buttons.change, cb(target.planId, 'open'))
          .row()
          .text(texts.library.buttons.cancel, 'lb:list'),
      };
    }
    case 'saved':
      return {
        text: t.saved(
          screen.target.title,
          count(screen.unitsPerDay, screen.target),
          formatUserDate(screen.endDate),
        ),
      };
  }
}
