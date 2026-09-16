import { InlineKeyboard } from 'grammy';
import { DateTime } from 'luxon';
import type { PauseScreen, ResumeResult } from '../../../app/pause.js';
import type { Notice, PlanShift } from '../../../app/ports.js';
import { formatUserDate } from '../../../core/plan/dates.js';
import { PAUSE_PRESETS } from '../../../core/plan/pausing.js';
import { texts } from '../texts.js';
import type { RenderedMessage } from './onboarding.js';

// Пауза (CLAUDE.md, раздел 5.5).

const t = texts.pause;

export const RESUME_CALLBACK = 'pause:resume';
/** callback_data: `pause:set:<d1|w1|w2|w3|m1|date|manual>`. */
export const PAUSE_SET_CALLBACK = /^pause:set:(\w+)$/;

const resumeKeyboard = (label: string) => new InlineKeyboard().text(label, RESUME_CALLBACK);

export function pauseMenuKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  (Object.keys(PAUSE_PRESETS) as (keyof typeof PAUSE_PRESETS)[]).forEach((preset, index) => {
    keyboard.text(t.buttons.presets[preset], `pause:set:${preset}`);
    if (index % 3 === 2) keyboard.row();
  });
  return keyboard
    .row()
    .text(t.buttons.date, 'pause:set:date')
    .row()
    .text(t.buttons.manual, 'pause:set:manual');
}

function shiftedLines(shifted: readonly PlanShift[]): string[] {
  const items = shifted.filter((s) => s.endDate !== null);
  if (items.length === 0) return [];
  return [
    '',
    t.shiftedTitle,
    ...items.map((s) => t.shiftedItem(s.title, formatUserDate(s.endDate!))),
  ];
}

export function resumedText(result: Extract<ResumeResult, { kind: 'resumed' }>): string {
  return [
    result.debtMessages > 0 ? t.resumedWithDebt : t.resumed,
    ...shiftedLines(result.shifted),
  ].join('\n');
}

export function pausedText(until: Date | null, timezone: string): string {
  if (!until) return t.pausedManual;
  const local = DateTime.fromJSDate(until, { zone: timezone });
  return t.pausedUntil(
    local.toFormat('dd.MM.yyyy'),
    local.toFormat('HH:mm'),
    local.toFormat('dd.MM'),
  );
}

export function renderPause(screen: Exclude<PauseScreen, { kind: 'stale' }>): RenderedMessage {
  switch (screen.kind) {
    case 'menu':
      return { text: t.menu, keyboard: pauseMenuKeyboard() };
    case 'ask_date':
      return { text: t.askDate(screen.maxDays, screen.invalid) };
    case 'paused':
      return {
        text: pausedText(screen.until, screen.timezone),
        keyboard: resumeKeyboard(t.buttons.resumeNow),
      };
    case 'resumed':
      return { text: resumedText(screen) };
    case 'not_paused':
      return { text: t.notPaused };
  }
}

export function noticeMessage(notice: Notice): RenderedMessage {
  switch (notice.kind) {
    case 'autopause':
      return { text: t.autoPaused, keyboard: resumeKeyboard(t.buttons.resume) };
    case 'pause_warning': {
      const time = DateTime.fromJSDate(notice.until, { zone: notice.timezone }).toFormat('HH:mm');
      return { text: t.warning(time), keyboard: resumeKeyboard(t.buttons.resumeNow) };
    }
    case 'pause_ended':
      return {
        text: [
          t.ended,
          ...(notice.debtMessages > 0 ? [t.debtAbove] : []),
          ...shiftedLines(notice.shifted),
        ].join('\n'),
      };
  }
}
