import { InlineKeyboard } from 'grammy';
import type { PaceChoiceResult, PaceNotice } from '../../../app/pace.js';
import type { UnitLabel } from '../../../app/ports.js';
import { formatUserDate } from '../../../core/plan/dates.js';
import { texts, unitCount } from '../texts.js';
import type { RenderedMessage } from './onboarding.js';

// «Успеть к сроку» / «Сдвинуть срок» (CLAUDE.md, раздел 5.2).

const t = texts.pace;

/** callback_data: `pc:<id плана>:<c — успеть | s — сдвинуть>`. */
export const PACE_CALLBACK = /^pc:(\d+):([cs])$/;

const perDay = (n: number, unit: UnitLabel) => unitCount(n, unit.strategy, unit.unitName);

export function paceMessage(notice: PaceNotice): RenderedMessage {
  const { check } = notice;
  if (check.kind === 'shifted') {
    return { text: t.shifted(notice.title, formatUserDate(check.endDate)) };
  }
  const current = perDay(notice.unitsPerDay, notice);
  const shiftEnd = formatUserDate(check.shiftEndDate);
  const deadline = formatUserDate(check.deadline);
  const lines = [t.behind(notice.title, current, shiftEnd, deadline), ''];
  const keyboard = new InlineKeyboard();
  if (check.catchUpUnitsPerDay !== null) {
    lines.push(t.catchUpOption(perDay(check.catchUpUnitsPerDay, notice), deadline));
    keyboard.text(t.buttons.catchUp, `pc:${notice.planId}:c`);
  }
  lines.push(t.shiftOption(current, shiftEnd));
  keyboard.text(t.buttons.shift, `pc:${notice.planId}:s`);
  if (check.catchUpUnitsPerDay === null) lines.push('', t.noDaysLeft);
  else if (check.adviseShift) lines.push('', t.adviseShift);
  return { text: lines.join('\n'), keyboard };
}

export function paceChoiceMessage(result: Exclude<PaceChoiceResult, { kind: 'stale' }>): string {
  const endDate = formatUserDate(result.endDate);
  return result.kind === 'shifted'
    ? t.shiftedChosen(result.title, endDate)
    : t.caughtUp(result.title, perDay(result.unitsPerDay, result.unit), endDate);
}
