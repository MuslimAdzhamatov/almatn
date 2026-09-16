import { InlineKeyboard } from 'grammy';
import type { BatchState } from '../../../app/reviews.js';
import type { BatchView, UnitLabel } from '../../../app/ports.js';
import type { UnitRange } from '../../../core/srs/ranges.js';
import { texts, unitPluralNominative, unitRangeLabel } from '../texts.js';
import { contextKeyboard } from './learning.js';
import type { RenderedMessage } from './onboarding.js';

// Сводный повтор и напоминание о долге (CLAUDE.md, разделы 5.1 и 5.2).

const t = texts.reviews;
const b = t.buttons;

/** callback_data: `rv:<id отправки>:<действие>`; кнопки контекста — общие с порцией (`po:`). */
export const REVIEW_CALLBACK = /^rv:(\d+):(ok|done|miss)$/;

const cb = (deliveryId: number, action: 'ok' | 'done' | 'miss') => `rv:${deliveryId}:${action}`;

/** «бейт 4», «бейты 1–10», «бейты 1–5, 16–20». */
export function rangesText(unit: UnitLabel, ranges: readonly UnitRange[]): string {
  const [single] = ranges;
  if (ranges.length === 1 && single) {
    return unitRangeLabel(
      single.lineStart,
      single.lineEnd,
      unit.strategy,
      unit.unitName,
    ).toLowerCase();
  }
  const parts = ranges.map((r) =>
    r.lineStart === r.lineEnd ? String(r.lineStart) : `${r.lineStart}–${r.lineEnd}`,
  );
  return `${unitPluralNominative(unit.strategy, unit.unitName)} ${parts.join(', ')}`;
}

export function batchKeyboard(
  state: Pick<BatchState, 'deliveryId' | 'kind' | 'buttons'> & UnitLabel,
) {
  const { deliveryId, buttons } = state;
  const keyboard = new InlineKeyboard();
  if (buttons.confirm) {
    keyboard
      .text(state.kind === 'review' ? b.confirm : b.confirmAll, cb(deliveryId, 'done'))
      .text(b.missed, cb(deliveryId, 'miss'))
      .row();
  }
  if (buttons.learn) {
    keyboard.text(b.learned(rangesText(state, [buttons.learn])), cb(deliveryId, 'ok')).row();
  }
  return contextKeyboard(deliveryId, state, keyboard);
}

export function batchMessage(view: BatchView): RenderedMessage {
  const keyboard = batchKeyboard(view);
  if (view.kind === 'review') {
    return { text: t.review(view.title, rangesText(view, view.reviews)), keyboard };
  }
  const items = [
    ...(view.reviews.length > 0 ? [t.repeatItem(rangesText(view, view.reviews))] : []),
    ...(view.portion ? [t.learnItem(rangesText(view, [view.portion]))] : []),
  ].join('\n');
  const text = (view.kind === 'evening' ? t.evening : t.debt)(view.title, items);
  return { text, keyboard };
}
