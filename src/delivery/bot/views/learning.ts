import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import {
  formatMask,
  type NextPortion,
  type PortionAction,
  type PortionInfo,
} from '../../../app/learning.js';
import type { PortionView, UnitLabel } from '../../../app/ports.js';
import { formatUserDate } from '../../../core/plan/dates.js';
import { texts, unitAccusative, unitPluralNominative, unitRangeLabel } from '../texts.js';
import type { RenderedMessage } from './onboarding.js';

const t = texts.learn;
const b = t.buttons;

/** callback_data: `po:<id отправки>:<действие>[:<значение>]`. */
export const PORTION_CALLBACK = /^po:(\d+):([a-z]+)(?::([0-9a-f]+))?(?::(\d+))?$/;

const cb = (deliveryId: number, action: string, ...args: (string | number)[]) =>
  ['po', deliveryId, action, ...args].join(':');

const range = (unit: UnitLabel, lineStart: number, lineEnd: number) =>
  unitRangeLabel(lineStart, lineEnd, unit.strategy, unit.unitName).toLowerCase();

export const portionRange = (p: PortionInfo | PortionView) => range(p, p.lineStart, p.lineEnd);

/** Подпись к картинке порции. */
export const pictureCaption = (unit: UnitLabel, lineStart: number, lineEnd: number) =>
  unitRangeLabel(lineStart, lineEnd, unit.strategy, unit.unitName);

function learnRow(keyboard: InlineKeyboard, deliveryId: number) {
  return keyboard
    .text(b.learned, cb(deliveryId, 'ok'))
    .text(b.still, cb(deliveryId, 'still'))
    .text(b.later, cb(deliveryId, 'later'))
    .row();
}

/** Кнопки контекста: остаются и после «Выучил». */
export function contextKeyboard(
  deliveryId: number,
  unit: UnitLabel,
  keyboard = new InlineKeyboard(),
) {
  const one = unitAccusative(unit.strategy, unit.unitName);
  return keyboard
    .text(b.more, cb(deliveryId, 'more'))
    .row()
    .text(b.up(one), cb(deliveryId, 'up'))
    .text(b.down(one), cb(deliveryId, 'down'))
    .row();
}

export function portionMessage(view: PortionView): RenderedMessage {
  const keyboard = contextKeyboard(
    view.deliveryId,
    view,
    learnRow(new InlineKeyboard(), view.deliveryId),
  );
  keyboard.text(b.skip, cb(view.deliveryId, 'skip'));
  const text = (view.replaced ? t.portionReplaced : t.portion)(view.title, portionRange(view));
  return { text, keyboard };
}

export function reminderMessage(view: PortionView): RenderedMessage {
  return {
    text: t.reminder(view.title, portionRange(view)),
    keyboard: learnRow(new InlineKeyboard(), view.deliveryId),
  };
}

const localTime = (at: Date, zone: string, format: string) =>
  DateTime.fromJSDate(at, { zone }).setLocale('ru').toFormat(format);

/** «сегодня в 18:00», «завтра в 06:00», «19.09 в 06:00». */
export function whenText(at: Date, zone: string, now = new Date()): string {
  const day = DateTime.fromJSDate(at, { zone }).startOf('day');
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  const diff = Math.round(day.diff(today, 'days').days);
  const time = localTime(at, zone, 'HH:mm');
  if (diff === 0) return `сегодня в ${time}`;
  if (diff === 1) return `завтра в ${time}`;
  return `${localTime(at, zone, 'dd.MM')} в ${time}`;
}

export function nextPortionText(next: NextPortion, zone: string, now = new Date()): string {
  switch (next.kind) {
    case 'sent':
      return t.nextSent;
    case 'at':
      return t.nextAt(whenText(next.at, zone, now));
    case 'debt':
      return t.nextDebt;
    case 'done':
      return t.nextDone;
    case 'paused':
      return t.nextPaused;
    case 'retry':
      return t.nextRetry;
  }
}

export function learnedMessage(
  action: Extract<PortionAction, { kind: 'learned' }>,
  now = new Date(),
): string {
  const zone = action.portion.timezone;
  return [
    t.learned(action.portion.title, portionRange(action.portion)),
    '',
    t.reviewsTitle,
    ...action.reviews.map(
      (review, index) => `• ${t.reviewStages[index]} — ${whenText(review.dueAt, zone, now)}`,
    ),
    '',
    nextPortionText(action.next, zone, now),
  ].join('\n');
}

export function skipMenu(action: Extract<PortionAction, { kind: 'skip_menu' }>): RenderedMessage {
  const { deliveryId, units, mask, portion } = action;
  const keyboard = new InlineKeyboard();
  if (mask === null) {
    return {
      text: t.skipTooMany,
      keyboard: keyboard
        .text(b.skipAll, cb(deliveryId, 'ska'))
        .row()
        .text(b.cancel, cb(deliveryId, 'skx')),
    };
  }
  units.forEach((lineNumber, index) => {
    const chosen = (mask >> BigInt(index)) & 1n;
    keyboard.text(
      chosen ? `✅ ${lineNumber}` : String(lineNumber),
      cb(deliveryId, 'skt', formatMask(mask), index),
    );
    if (index % 5 === 4) keyboard.row();
  });
  keyboard.row();
  const count = units.filter((_, index) => (mask >> BigInt(index)) & 1n).length;
  if (count > 0) {
    keyboard.text(b.skipSelected(count), cb(deliveryId, 'sks', formatMask(mask))).row();
  }
  keyboard.text(b.skipAll, cb(deliveryId, 'ska')).text(b.cancel, cb(deliveryId, 'skx'));
  return {
    text: t.skipQuestion(unitPluralNominative(portion.strategy, portion.unitName)),
    keyboard,
  };
}

/** Номера подряд → «бейт 4», «бейты 1–3, 7». */
export function listUnits(unit: UnitLabel, numbers: readonly number[]): string {
  const [first] = numbers;
  if (numbers.length === 1 && first !== undefined) return range(unit, first, first);
  const parts: string[] = [];
  for (const n of numbers) {
    const last = parts.at(-1);
    const end = last === undefined ? NaN : Number(last.split('–').at(-1));
    if (n === end + 1) parts[parts.length - 1] = `${last!.split('–')[0]}–${n}`;
    else parts.push(String(n));
  }
  return `${unitPluralNominative(unit.strategy, unit.unitName)} ${parts.join(', ')}`;
}

export function skippedMessage(action: Extract<PortionAction, { kind: 'skipped' }>): string {
  const lines = [t.skipped(listUnits(action.portion, action.skipped))];
  if (!action.replaced) lines.push(t.skippedNothingLeft);
  else if (action.endDate) lines.push(t.skippedReplaced(formatUserDate(action.endDate)));
  return lines.join('\n');
}
