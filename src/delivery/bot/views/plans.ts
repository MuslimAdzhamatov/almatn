import { InlineKeyboard } from 'grammy';
import type { NextPortion } from '../../../app/learning.js';
import type { PlanScreen, UnitInfo } from '../../../app/plans.js';
import { formatUserDate } from '../../../core/plan/dates.js';
import {
  scheduleText,
  texts,
  unitCount,
  unitCountGenitive,
  unitNounMany,
  unitRangeLabel,
} from '../texts.js';
import { whenText } from './learning.js';
import type { RenderedMessage } from './onboarding.js';

const t = texts.plan;
const b = t.buttons;

/** callback_data: `pl:<токен>:<действие>[:<значение>]` — укладывается в 64 байта. */
export const PLAN_CALLBACK = /^pl:([0-9a-z]+):([a-z]+)(?::(.+))?$/;

const cb = (token: string, action: string, arg?: string | number) =>
  arg === undefined ? `pl:${token}:${action}` : `pl:${token}:${action}:${arg}`;

const count = (n: number, unit: UnitInfo) => unitCount(n, unit.strategy, unit.unitName);

const DAYS_PRESETS = [7, 14, 30, 60, 90];
const MONTHS_PRESETS = [1, 2, 3, 6, 12];
const PER_DAY_PRESETS = [2, 3, 5];
const SEND_TIME_PRESETS = ['05:00', '06:00', '07:00', '08:00', '18:00', '20:00'];

function restDaysText(restDays: readonly number[]): string {
  if (restDays.length === 0) return t.restNone;
  return t.restList(restDays.map((day) => t.weekdays[day - 1]).join(', '));
}

function rowOf(keyboard: InlineKeyboard, buttons: [label: string, data: string][]) {
  for (const [label, data] of buttons) keyboard.text(label, data);
  return keyboard.row();
}

type Shown = Exclude<PlanScreen, { kind: 'stale' }>;

/** Когда придёт первая порция — после «Начать». */
function firstPortionText(next: NextPortion | undefined, timezone: string): string {
  switch (next?.kind) {
    case 'sent':
      return t.firstNow;
    case 'at':
      return t.firstAt(whenText(next.at, timezone));
    case 'paused':
      return t.firstPaused;
    default:
      return t.firstRetry;
  }
}

/** next — когда придёт первая порция (для экрана «План создан»). */
export function renderPlan(screen: Shown, next?: NextPortion): RenderedMessage {
  switch (screen.kind) {
    case 'scope': {
      const { token } = screen;
      return {
        text: t.scope(screen.title),
        keyboard: new InlineKeyboard()
          .text(b.all(count(screen.total, screen.unit)), cb(token, 'all'))
          .row()
          .text(b.range, cb(token, 'range'))
          .row()
          .text(b.later, cb(token, 'later')),
      };
    }

    case 'scope_input':
      return { text: t.scopeInput(count(screen.total, screen.unit), screen.invalid) };

    case 'pace':
      return {
        text: t.pace(count(screen.total, screen.unit)),
        keyboard: new InlineKeyboard()
          .text(b.byDeadline, cb(screen.token, 'pace', 'deadline'))
          .row()
          .text(b.perDay, cb(screen.token, 'pace', 'per_day')),
      };

    case 'deadline_kind': {
      const { token } = screen;
      return {
        text: t.deadlineKind,
        keyboard: new InlineKeyboard()
          .text(b.days, cb(token, 'dlk', 'days'))
          .row()
          .text(b.months, cb(token, 'dlk', 'months'))
          .row()
          .text(b.date, cb(token, 'dlk', 'date'))
          .row()
          .text(b.back, cb(token, 'edit', 'pace')),
      };
    }

    case 'deadline_input': {
      const { token, error } = screen;
      const start = formatUserDate(screen.startDate);
      const keyboard = new InlineKeyboard();
      let question: string;
      if (screen.input === 'days') {
        question = t.deadlineDays(screen.maxDays);
        rowOf(
          keyboard,
          DAYS_PRESETS.map((n) => [String(n), cb(token, 'dlv', `days:${n}`)]),
        );
      } else if (screen.input === 'months') {
        question = t.deadlineMonths;
        rowOf(
          keyboard,
          MONTHS_PRESETS.map((n) => [String(n), cb(token, 'dlv', `months:${n}`)]),
        );
      } else {
        question = t.deadlineDate(start);
        for (const preset of screen.presets) {
          keyboard
            .text(
              b.datePreset(preset.months, formatUserDate(preset.date)),
              cb(token, 'dlv', `date:${preset.date}`),
            )
            .row();
        }
      }
      if (error === 'no_working_days') keyboard.text(b.editRest, cb(token, 'edit', 'rest')).row();
      keyboard.text(b.back, cb(token, 'pace', 'deadline'));

      const errorText =
        error === null
          ? null
          : error === 'too_long'
            ? t.deadlineErrors.too_long(screen.maxDays)
            : error === 'deadline_before_start'
              ? t.deadlineErrors.deadline_before_start(start)
              : t.deadlineErrors[error];
      return { text: errorText ? `${errorText}\n\n${question}` : question, keyboard };
    }

    case 'per_day': {
      const { token, unit } = screen;
      const keyboard = rowOf(
        new InlineKeyboard(),
        PER_DAY_PRESETS.filter((n) => n <= screen.total).map((n) => [
          String(n),
          cb(token, 'upd', n),
        ]),
      ).text(b.back, cb(token, 'edit', 'pace'));
      return {
        text: t.perDay(unitNounMany(unit.strategy, unit.unitName), screen.total, screen.invalid),
        keyboard,
      };
    }

    case 'rest_days': {
      const { token, restDays } = screen;
      const keyboard = new InlineKeyboard();
      t.weekdaysShort.forEach((label, index) => {
        const day = index + 1;
        keyboard.text(restDays.includes(day) ? `✅ ${label}` : label, cb(token, 'rest', day));
      });
      keyboard.row().text(b.restDone, cb(token, 'restok')).text(b.restNone, cb(token, 'restnone'));
      return { text: `${t.restDays}\n\n${restDaysText(restDays)}`, keyboard };
    }

    case 'start_date':
      return {
        text: t.startDate(formatUserDate(screen.today), screen.maxDays, screen.invalid),
        keyboard: new InlineKeyboard()
          .text(b.todayStart, cb(screen.token, 'start', 'today'))
          .text(b.tomorrow, cb(screen.token, 'start', 'tomorrow'))
          .row()
          .text(b.back, cb(screen.token, 'go')),
      };

    case 'send_time': {
      const keyboard = new InlineKeyboard();
      SEND_TIME_PRESETS.forEach((time, index) => {
        keyboard.text(time, cb(screen.token, 'time', time));
        if (index % 3 === 2) keyboard.row();
      });
      return {
        text: t.sendTime(screen.invalid),
        keyboard: keyboard.text(b.back, cb(screen.token, 'go')),
      };
    }

    case 'overload': {
      const { summary, unit, token } = screen;
      return {
        text: t.overload(
          count(summary.unitsPerDay, unit),
          unitCountGenitive(summary.load.peak, unit.strategy, unit.unitName),
        ),
        keyboard: new InlineKeyboard()
          .text(b.reduce, cb(token, 'reduce'))
          .row()
          .text(b.force, cb(token, 'force')),
      };
    }

    case 'confirm':
      return { text: confirmText(screen), keyboard: confirmKeyboard(screen.token) };

    case 'started':
      return { text: t.started(screen.title, firstPortionText(next, screen.timezone)) };

    case 'postponed':
      return { text: t.postponed };

    case 'already_planned':
      return { text: t.alreadyPlanned(screen.title) };
  }
}

function confirmText(screen: Extract<PlanScreen, { kind: 'confirm' }>): string {
  const { summary, unit, overlap } = screen;
  const perDay = count(summary.unitsPerDay, unit);
  const { typicalLow, typicalHigh, peak } = summary.load;
  const typical = count(typicalHigh, unit);
  const typicalRange = typicalLow === typicalHigh ? `~${typical}` : `${typicalLow}–${typical}`;

  const lines = [
    t.confirmTitle(
      screen.title,
      unitRangeLabel(screen.lineFrom, screen.lineTo, unit.strategy, unit.unitName).toLowerCase(),
      count(summary.totalUnits, unit),
    ),
    summary.deadlineDate
      ? t.paceDeadline(perDay, formatUserDate(summary.deadlineDate))
      : t.pacePerDay(perDay),
    restDaysText(summary.restDays),
    t.start(formatUserDate(screen.startDate), screen.startDate === screen.today),
  ];
  if (summary.firstDate !== screen.startDate) {
    lines.push(t.firstPortion(formatUserDate(summary.firstDate)));
  }
  lines.push(t.endDates(formatUserDate(summary.endDate), formatUserDate(summary.lastReviewDate)));
  if (summary.endsEarly) {
    lines.push(summary.unitsPerDay === 1 ? t.endsEarlyShort : t.endsEarlyRounded);
  }
  lines.push(t.load(typicalRange, peak), '', scheduleText(screen.schedule));
  if (overlap) {
    lines.push(
      '',
      t.overlap(
        overlap.titles.map((title) => `«${title}»`).join(', '),
        overlap.upcomingTotal,
        overlap.upcomingPeak,
        overlap.combinedPeak,
      ),
    );
  }
  return lines.join('\n');
}

function confirmKeyboard(token: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(b.go, cb(token, 'go'))
    .row()
    .text(b.editPace, cb(token, 'edit', 'pace'))
    .text(b.editRest, cb(token, 'edit', 'rest'))
    .row()
    .text(b.editStart, cb(token, 'edit', 'start'))
    .text(b.editTime, cb(token, 'edit', 'time'));
}
