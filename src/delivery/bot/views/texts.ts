import { InlineKeyboard } from 'grammy';
import type { UnitName } from '../../../app/ports.js';
import type {
  IngestResult,
  LineImage,
  ParseEvent,
  TextAction,
  TextSummary,
  UploadCheck,
} from '../../../app/texts.js';
import { texts, unitCount, unitRangeLabel } from '../texts.js';
import type { RenderedMessage } from './onboarding.js';

const t = texts.upload;

export const textCallbacks = {
  confirm: 'txok',
  unit: 'txunit',
  reparse: 'txre',
  cancel: 'txno',
  keepTitle: 'txkeep',
  pending: 'txpend',
  images: 'tximg',
} as const;

/** Кнопки под сообщением о собранных страницах-картинках. */
export function imagesKeyboard(pages: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(t.buttons.imagesDone(pages), `${textCallbacks.images}:done`)
    .row()
    .text(t.buttons.imagesCancel, `${textCallbacks.images}:cancel`);
}

const MAX_ANOMALIES_SHOWN = 10;

export function pendingQuestion(
  check: Extract<UploadCheck, { kind: 'pending_confirm' }>,
): RenderedMessage {
  return {
    text: t.pendingQuestion(check.title),
    keyboard: new InlineKeyboard()
      .text(t.buttons.resumePending(check.title), `${textCallbacks.pending}:${check.token}:keep`)
      .row()
      .text(t.buttons.replacePending, `${textCallbacks.pending}:${check.token}:replace`),
  };
}

export function uploadCheckText(
  check: Exclude<UploadCheck, { kind: 'ok' | 'pending_confirm' }>,
): string {
  switch (check.kind) {
    case 'unsupported':
      return t.unsupported;
    case 'too_big':
      return t.tooBig(check.limitMb);
    case 'too_many_texts':
      return t.tooManyTexts(check.limit);
  }
}

export function ingestText(result: IngestResult): string {
  switch (result.kind) {
    case 'accepted':
      return t.accepted(result.queued);
    case 'duplicate':
      return t.duplicate(result.title);
    case 'too_big':
      return t.tooBig(result.limitMb);
    case 'password':
      return t.password;
    case 'damaged':
      return t.damaged;
    case 'empty':
      return t.empty;
    case 'too_many_pages':
      return t.tooManyPages(result.pages, result.limit);
  }
}

export function parseFailedText(event: Extract<ParseEvent, { kind: 'failed' }>): string {
  if (event.reason === 'password') return t.password;
  return t.parseFailed(event.fileName);
}

export function summaryText(summary: TextSummary): string {
  const { report, strategy, unitName } = summary;
  const count = unitCount(summary.totalLines, strategy, unitName);
  const lines = [t.summaryTitle(summary.title, summary.originalFileName), ''];

  if (strategy === 'manual_page') {
    lines.push(
      report.fallbackReason === 'no_text_layer' ? t.noTextLayerFallback(count) : t.byPages(count),
    );
  } else {
    lines.push(
      t.found(count, report.firstPage, report.lastPage, summary.pageCount),
      strategyNote(strategy),
    );
    if (report.anomalies.length > 0) {
      lines.push('', t.anomaliesTitle);
      for (const anomaly of report.anomalies.slice(0, MAX_ANOMALIES_SHOWN)) {
        lines.push(`• ${t.anomaly(anomaly)}`);
      }
      if (report.anomalies.length > MAX_ANOMALIES_SHOWN) {
        lines.push(t.moreAnomalies(report.anomalies.length - MAX_ANOMALIES_SHOWN));
      }
    }
  }

  lines.push('', strategy === 'manual_page' ? t.previewPage : t.previewLines);
  return lines.join('\n');
}

function strategyNote(strategy: TextSummary['strategy']): string {
  if (strategy === 'text_lines') return t.byTextLines;
  if (strategy === 'image_lines') return t.byImageLines;
  return t.byNumbers;
}

export function imageCaption(summary: TextSummary, image: LineImage): string {
  return unitRangeLabel(image.lineStart, image.lineEnd, summary.strategy, summary.unitName);
}

export function parseSummaryKeyboard(summary: TextSummary): InlineKeyboard {
  const id = summary.textId;
  const keyboard = new InlineKeyboard()
    .text(t.buttons.confirm, `${textCallbacks.confirm}:${id}`)
    .row();
  if (
    summary.strategy === 'numbers' ||
    summary.strategy === 'text_lines' ||
    summary.strategy === 'image_lines'
  ) {
    const nextUnit: UnitName = summary.unitName === 'lines' ? 'bayts' : 'lines';
    keyboard.text(t.buttons.callAs(nextUnit), `${textCallbacks.unit}:${id}:${nextUnit}`).row();
    keyboard.text(t.buttons.byPages, `${textCallbacks.reparse}:${id}:manual_page`).row();
  } else if (summary.report.fallbackReason !== 'no_text_layer') {
    keyboard.text(t.buttons.byNumbers, `${textCallbacks.reparse}:${id}:auto`).row();
  }
  return keyboard.text(t.buttons.cancel, `${textCallbacks.cancel}:${id}`);
}

type ShownAction = Exclude<TextAction, { kind: 'stale' | 'unit_changed' }>;

export function actionMessage(action: ShownAction): RenderedMessage {
  switch (action.kind) {
    case 'ask_title':
      return {
        text: t.askTitle(action.defaultTitle),
        keyboard: new InlineKeyboard()
          .text(
            t.buttons.keepTitle(action.defaultTitle),
            `${textCallbacks.keepTitle}:${action.textId}`,
          )
          .row()
          .text(t.buttons.cancel, `${textCallbacks.cancel}:${action.textId}`),
      };
    case 'saved':
      return {
        text: t.saved(action.title, unitCount(action.totalLines, action.strategy, action.unitName)),
      };
    case 'reparsing':
      return { text: t.reparsing };
    case 'cancelled':
      return { text: t.cancelled };
    case 'invalid_title':
      return { text: t.invalidTitle(action.maxLength) };
  }
}
