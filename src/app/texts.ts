import { basename, extname } from 'node:path';
import { BYTES_IN_MB, limits } from '../config/limits.js';
import { groupIntoSegments, segmentPixelRect } from '../core/pdf/crop.js';
import type { LineBox } from '../core/pdf/layout.js';
import { PdfToolError } from '../core/pdf/poppler.js';
import { parsePdf, type ParseMode } from './parsing.js';
import type {
  DialogStore,
  FileStore,
  ParseReport,
  ParseStrategy,
  PdfTools,
  TextRecord,
  TextStatus,
  TextsStore,
  UnitName,
} from './ports.js';
import { createSerialQueue } from './queue.js';

// Приём PDF (CLAUDE.md, раздел 4.1): проверки → сохранение → разбор в фоне → сводка → подтверждение и название.

const FLOW = 'upload';

export type UploadCheck =
  | { kind: 'ok' }
  | { kind: 'not_pdf' }
  | { kind: 'too_big'; limitMb: number }
  | { kind: 'too_many_texts'; limit: number };

export type IngestResult =
  | { kind: 'accepted'; textId: number; queued: number }
  | { kind: 'duplicate'; textId: number; title: string }
  | { kind: 'too_big'; limitMb: number }
  | { kind: 'password' }
  | { kind: 'damaged' }
  | { kind: 'empty' }
  | { kind: 'too_many_pages'; pages: number; limit: number };

export interface TextSummary {
  textId: number;
  title: string;
  originalFileName: string;
  unitName: UnitName;
  strategy: ParseStrategy;
  totalLines: number;
  pageCount: number;
  report: ParseReport;
}

export interface LineImage {
  page: number;
  lineStart: number;
  lineEnd: number;
  png: Buffer;
}

export type TextAction =
  | { kind: 'ask_title'; textId: number; defaultTitle: string }
  | {
      kind: 'saved';
      textId: number;
      title: string;
      totalLines: number;
      unitName: UnitName;
      strategy: ParseStrategy;
    }
  | { kind: 'unit_changed'; summary: TextSummary }
  | { kind: 'reparsing'; textId: number }
  | { kind: 'cancelled' }
  | { kind: 'invalid_title'; maxLength: number }
  | { kind: 'stale' };

export type ParseEvent =
  | { kind: 'parsed'; userId: bigint; textId: number }
  | {
      kind: 'failed';
      userId: bigint;
      fileName: string;
      reason: 'password' | 'damaged' | 'internal';
    };

export interface TextsDeps {
  store: TextsStore;
  dialogs: DialogStore;
  files: FileStore;
  tools: PdfTools;
  reportError?: (err: unknown, context: Record<string, unknown>) => void;
}

export function titleFromFileName(fileName: string): string {
  // extname('.pdf') — пустая строка (Node считает это скрытым файлом), поэтому расширение режем явно.
  const base = basename(fileName)
    .replace(/\.pdf$/i, '')
    .replace(/_+/g, ' ')
    .trim();
  return (base || 'Текст').slice(0, limits.texts.maxTitleLength);
}

export function createTexts({
  store,
  dialogs,
  files,
  tools,
  reportError = () => undefined,
}: TextsDeps) {
  const queue = createSerialQueue();
  const listeners: ((event: ParseEvent) => Promise<void> | void)[] = [];

  async function emit(event: ParseEvent) {
    for (const listener of listeners) {
      try {
        await listener(event);
      } catch (err) {
        reportError(err, { event: event.kind });
      }
    }
  }

  async function removeText(text: TextRecord) {
    await store.delete(text.id);
    await files.removeText(text.id);
  }

  async function runParse(textId: number, mode: ParseMode) {
    const text = await store.get(textId);
    if (!text || text.status !== 'parsing') return;
    const workDir = await files.workDir(textId);
    try {
      const parsed = await parsePdf(text.filePath, workDir, tools, mode);
      await store.replaceLines(textId, parsed.boxes);
      await store.update(textId, {
        status: 'awaiting_confirm',
        parseStrategy: parsed.strategy,
        totalLines: parsed.boxes.length,
        parseReport: parsed.report,
        parseError: null,
      });
      await files.removeDir(workDir);
      await emit({ kind: 'parsed', userId: text.userId, textId });
    } catch (err) {
      await files.removeDir(workDir);
      const reason = err instanceof PdfToolError ? err.reason : 'internal';
      if (reason === 'internal') reportError(err, { textId });
      // Неразобранный текст удаляется, чтобы не занимать место в лимите текстов пользователя.
      await removeText(text);
      await emit({ kind: 'failed', userId: text.userId, fileName: text.originalFileName, reason });
    }
  }

  function enqueue(textId: number, mode: ParseMode) {
    queue.push(() => runParse(textId, mode).catch((err: unknown) => reportError(err, { textId })));
  }

  async function ownText(userId: bigint, textId: number, status: TextStatus) {
    const text = await store.get(textId);
    return text && text.userId === userId && text.status === status ? text : null;
  }

  function toSummary(text: TextRecord): TextSummary | null {
    if (!text.parseStrategy || !text.parseReport) return null;
    return {
      textId: text.id,
      title: text.title,
      originalFileName: text.originalFileName,
      unitName: text.unitName,
      strategy: text.parseStrategy,
      totalLines: text.totalLines,
      pageCount: text.pageCount,
      report: text.parseReport,
    };
  }

  async function finish(text: TextRecord, title: string): Promise<TextAction> {
    await store.update(text.id, { title, status: 'ready' });
    await dialogs.clear(text.userId);
    return {
      kind: 'saved',
      textId: text.id,
      title,
      totalLines: text.totalLines,
      unitName: text.unitName,
      strategy: text.parseStrategy ?? 'manual_page',
    };
  }

  /** Картинки строк: подряд идущие строки одной страницы — одна картинка. */
  async function renderLineImages(
    text: TextRecord,
    boxes: readonly LineBox[],
  ): Promise<LineImage[]> {
    const outDir = await files.pagesDir(text.id);
    const dpi = limits.pdf.cropDpi;
    const images: LineImage[] = [];
    for (const segment of groupIntoSegments(boxes)) {
      const path = await tools.renderPage(text.filePath, { outDir, dpi, page: segment.page });
      const size = await tools.imageSize(path);
      const page = { widthPt: (size.width * 72) / dpi, heightPt: (size.height * 72) / dpi };
      const rect = segmentPixelRect(segment, page, size);
      images.push({
        page: segment.page,
        lineStart: segment.lineStart,
        lineEnd: segment.lineEnd,
        png: await tools.crop(path, rect),
      });
    }
    return images;
  }

  return {
    onParseEvent(listener: (event: ParseEvent) => Promise<void> | void) {
      listeners.push(listener);
    },

    /** Дождаться окончания всех разборов (тесты, корректная остановка). */
    idle: () => queue.idle(),

    /** Проверка до скачивания — по данным, которые Telegram сообщает о документе. */
    async checkUpload(input: {
      userId: bigint;
      fileName: string;
      mimeType?: string | undefined;
      fileSize?: number | undefined;
    }): Promise<UploadCheck> {
      const isPdf =
        input.mimeType === 'application/pdf' || extname(input.fileName).toLowerCase() === '.pdf';
      if (!isPdf) return { kind: 'not_pdf' };
      if ((input.fileSize ?? 0) > limits.pdf.maxBytes) {
        return { kind: 'too_big', limitMb: limits.pdf.maxBytes / BYTES_IN_MB };
      }
      if ((await store.countByUser(input.userId)) >= limits.texts.maxPerUser) {
        return { kind: 'too_many_texts', limit: limits.texts.maxPerUser };
      }
      return { kind: 'ok' };
    },

    /** Скачанный файл: дубликат, пароль, число страниц → создание текста и постановка в очередь разбора. */
    async ingest(input: {
      userId: bigint;
      fileName: string;
      fileSize: number;
      tempPath: string;
    }): Promise<IngestResult> {
      const discard = () => files.removeFile(input.tempPath);

      if (input.fileSize > limits.pdf.maxBytes) {
        await discard();
        return { kind: 'too_big', limitMb: limits.pdf.maxBytes / BYTES_IN_MB };
      }

      const sha256 = await files.sha256(input.tempPath);
      const existing = await store.findBySha(input.userId, sha256);
      if (existing) {
        await discard();
        return { kind: 'duplicate', textId: existing.id, title: existing.title };
      }

      let pages: number;
      try {
        ({ pages } = await tools.info(input.tempPath));
      } catch (err) {
        await discard();
        if (err instanceof PdfToolError) {
          return err.reason === 'password' ? { kind: 'password' } : { kind: 'damaged' };
        }
        throw err;
      }
      if (pages === 0) {
        await discard();
        return { kind: 'empty' };
      }
      if (pages > limits.pdf.maxPages) {
        await discard();
        return { kind: 'too_many_pages', pages, limit: limits.pdf.maxPages };
      }

      const text = await store.create({
        userId: input.userId,
        title: titleFromFileName(input.fileName),
        originalFileName: input.fileName,
        filePath: input.tempPath,
        fileSize: input.fileSize,
        sha256,
        pageCount: pages,
      });
      await store.update(text.id, { filePath: await files.adoptSource(input.tempPath, text.id) });
      enqueue(text.id, 'auto');
      return { kind: 'accepted', textId: text.id, queued: queue.pending };
    },

    /** При старте бота: разборы, прерванные перезапуском, запускаются заново. */
    async resumeParsing() {
      for (const text of await store.listByStatus('parsing')) enqueue(text.id, 'auto');
    },

    async summary(textId: number): Promise<TextSummary | null> {
      const text = await store.get(textId);
      return text?.status === 'awaiting_confirm' ? toSummary(text) : null;
    },

    async previewImages(textId: number): Promise<LineImage[]> {
      const text = await store.get(textId);
      if (!text) return [];
      const count = text.parseStrategy === 'manual_page' ? 1 : limits.pdf.previewLines;
      return renderLineImages(text, await store.firstLines(textId, count));
    },

    async confirm(userId: bigint, textId: number): Promise<TextAction> {
      const text = await ownText(userId, textId, 'awaiting_confirm');
      if (!text) return { kind: 'stale' };
      await dialogs.set(userId, { flow: FLOW, step: 'title', data: { textId } });
      return { kind: 'ask_title', textId, defaultTitle: text.title };
    },

    async setUnit(userId: bigint, textId: number, unit: string): Promise<TextAction> {
      if (unit !== 'lines' && unit !== 'bayts') return { kind: 'stale' };
      const text = await ownText(userId, textId, 'awaiting_confirm');
      if (!text) return { kind: 'stale' };
      await store.update(textId, { unitName: unit });
      const summary = toSummary({ ...text, unitName: unit });
      return summary ? { kind: 'unit_changed', summary } : { kind: 'stale' };
    },

    async reparse(userId: bigint, textId: number, mode: string): Promise<TextAction> {
      if (mode !== 'auto' && mode !== 'manual_page') return { kind: 'stale' };
      const text = await ownText(userId, textId, 'awaiting_confirm');
      if (!text) return { kind: 'stale' };
      await store.update(textId, { status: 'parsing' });
      enqueue(textId, mode);
      return { kind: 'reparsing', textId };
    },

    async cancel(userId: bigint, textId: number): Promise<TextAction> {
      const text = await ownText(userId, textId, 'awaiting_confirm');
      if (!text) return { kind: 'stale' };
      await removeText(text);
      const dialog = await dialogs.get(userId);
      if (dialog?.flow === FLOW && dialog.data.textId === textId) await dialogs.clear(userId);
      return { kind: 'cancelled' };
    },

    async keepTitle(userId: bigint, textId: number): Promise<TextAction> {
      const text = await ownText(userId, textId, 'awaiting_confirm');
      return text ? finish(text, text.title) : { kind: 'stale' };
    },

    /** Текст сообщения на шаге «название»; null — пользователь не на этом шаге. */
    async handleTitleText(userId: bigint, input: string): Promise<TextAction | null> {
      const dialog = await dialogs.get(userId);
      if (dialog?.flow !== FLOW || dialog.step !== 'title') return null;
      const text = await ownText(userId, Number(dialog.data.textId), 'awaiting_confirm');
      if (!text) {
        await dialogs.clear(userId);
        return { kind: 'stale' };
      }
      const title = input.trim();
      if (!title || title.length > limits.texts.maxTitleLength) {
        return { kind: 'invalid_title', maxLength: limits.texts.maxTitleLength };
      }
      return finish(text, title);
    },
  };
}

export type Texts = ReturnType<typeof createTexts>;
