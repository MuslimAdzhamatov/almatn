import { randomBytes } from 'node:crypto';
import { basename, extname } from 'node:path';
import { BYTES_IN_MB, limits } from '../config/limits.js';
import { groupIntoSegments, segmentPixelRect } from '../core/pdf/crop.js';
import type { LineBox } from '../core/pdf/layout.js';
import { PdfToolError } from '../core/pdf/poppler.js';
import { parseImagePages, parsePdf, type ParseMode } from './parsing.js';
import type {
  DialogStore,
  FileStore,
  ParseReport,
  ParseStrategy,
  PdfTools,
  PendingUpload,
  TextRecord,
  TextStatus,
  TextsStore,
  UnitName,
  UploadsStore,
} from './ports.js';
import { createSerialQueue } from './queue.js';

// Приём PDF (CLAUDE.md, раздел 4.1): проверки → сохранение → разбор в фоне → сводка → подтверждение и название.

const FLOW = 'upload';

/** Присланный файл по данным Telegram — до скачивания; хранится в DialogState, пока бот ждёт ответа. */
export interface IncomingFile {
  fileId: string;
  fileName: string;
  mimeType?: string | undefined;
  fileSize?: number | undefined;
  fileUniqueId?: string | undefined;
  /** Альбом Telegram: несколько картинок пришли одним сообщением пользователя. */
  mediaGroupId?: string | undefined;
}

/** PDF или картинка страницы. */
export type UploadKind = 'pdf' | 'image';

export type UploadCheck =
  | { kind: 'ok'; upload: UploadKind }
  | { kind: 'unsupported' }
  | { kind: 'too_big'; limitMb: number }
  | { kind: 'too_many_texts'; limit: number }
  /** Есть текст, ожидающий подтверждения разбора: сначала спросить, что с ним сделать. */
  | { kind: 'pending_confirm'; textId: number; title: string; token: string };

export type PendingChoice =
  /** Заново показать сводку неподтверждённого текста; новый файл не загружается. */
  | { kind: 'resume'; textId: number; title: string }
  /** Неподтверждённый текст удалён (если он ещё ждал подтверждения) — загрузить новый файл. */
  | { kind: 'replace'; removedTitle: string | null; file: IncomingFile }
  | { kind: 'stale' };

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
  /** Присланные файлы, которые ещё не стали текстом: страницы альбома, файл до конца настройки. */
  uploads: UploadsStore;
  dialogs: DialogStore;
  files: FileStore;
  tools: PdfTools;
  reportError?: (err: unknown, context: Record<string, unknown>) => void;
  /** Одноразовый токен вопроса о неподтверждённом тексте — делает старые кнопки неактуальными. */
  newToken?: () => string;
}

const PENDING_STEP = 'pending_choice';
const IMAGES_STEP = 'images';

const UNIT_NAMES: readonly UnitName[] = ['lines', 'bayts', 'hadiths', 'paragraphs'];

const isUnitName = (value: string): value is UnitName => UNIT_NAMES.includes(value as UnitName);

export function titleFromFileName(fileName: string): string {
  // extname('.pdf') — пустая строка (Node считает это скрытым файлом), поэтому расширение режем явно.
  const base = basename(fileName)
    .replace(/\.(pdf|jpe?g|png)$/i, '')
    .replace(/_+/g, ' ')
    .trim();
  return (base || 'Текст').slice(0, limits.texts.maxTitleLength);
}

/** PDF, картинка или неподдерживаемый файл — по типу и расширению, которые сообщил Telegram. */
export function classifyUpload(file: IncomingFile): UploadKind | null {
  const extension = extname(file.fileName).toLowerCase();
  if (file.mimeType === 'application/pdf' || extension === '.pdf') return 'pdf';
  const mimeType = file.mimeType ?? '';
  if (
    limits.images.mimeTypes.some((type) => type === mimeType) ||
    limits.images.extensions.some((known) => known === extension)
  ) {
    return 'image';
  }
  return null;
}

export function createTexts({
  store,
  uploads,
  dialogs,
  files,
  tools,
  reportError = () => undefined,
  newToken = () => randomBytes(4).toString('hex'),
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
      // У текста из картинок страница — сам файл, рендерить нечего.
      const parsed =
        text.sourceKind === 'images'
          ? await parseImagePages(await files.listImagePages(textId), tools)
          : await parsePdf(text.filePath, workDir, tools, mode, files.removeFile);
      if (!parsed) throw new PdfToolError('Не удалось найти строки на картинках', 'damaged');
      await store.replaceLines(textId, parsed.boxes);
      await store.update(textId, {
        status: 'awaiting_confirm',
        parseStrategy: parsed.strategy,
        // У прозы единица — абзац; в сборнике хадисов пользователь переключит её на «хадисы».
        ...(parsed.strategy === 'paragraphs' && { unitName: 'paragraphs' as const }),
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
    const dpi = limits.pdf.cropDpi;
    // Для текста из картинок координаты хранятся в пикселях страницы, поэтому масштаб равен 1.
    const imagePages = text.sourceKind === 'images' ? await files.listImagePages(text.id) : null;
    const outDir = imagePages ? '' : await files.pagesDir(text.id);
    const images: LineImage[] = [];
    for (const segment of groupIntoSegments(boxes)) {
      const path =
        imagePages?.[segment.page - 1] ??
        (imagePages
          ? null
          : await tools.renderPage(text.filePath, { outDir, dpi, page: segment.page }));
      if (!path) continue;
      const size = await tools.imageSize(path);
      const page = imagePages
        ? { widthPt: size.width, heightPt: size.height }
        : { widthPt: (size.width * 72) / dpi, heightPt: (size.height * 72) / dpi };
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

    /**
     * Проверка до скачивания — по данным, которые Telegram сообщает о документе.
     * Если у пользователя есть неподтверждённый текст, файл запоминается в диалоге и бот спрашивает,
     * что с тем текстом сделать (раньше лимита текстов: удаление неподтверждённого освобождает место).
     */
    async checkUpload(userId: bigint, file: IncomingFile): Promise<UploadCheck> {
      const upload = classifyUpload(file);
      if (!upload) return { kind: 'unsupported' };
      const maxBytes = upload === 'pdf' ? limits.pdf.maxBytes : limits.images.maxBytes;
      if ((file.fileSize ?? 0) > maxBytes) {
        return { kind: 'too_big', limitMb: maxBytes / BYTES_IN_MB };
      }
      const pending = await store.findFirstByStatus(userId, 'awaiting_confirm');
      if (pending) {
        const token = newToken();
        await dialogs.set(userId, {
          flow: FLOW,
          step: PENDING_STEP,
          data: { token, textId: pending.id, file: { ...file } },
        });
        return { kind: 'pending_confirm', textId: pending.id, title: pending.title, token };
      }
      if ((await store.countByUser(userId)) >= limits.texts.maxPerUser) {
        return { kind: 'too_many_texts', limit: limits.texts.maxPerUser };
      }
      return { kind: 'ok', upload };
    },

    /** Картинка-страница кладётся в копилку: текст создаётся только по кнопке «Готово». */
    async addImagePage(
      userId: bigint,
      file: IncomingFile,
    ): Promise<{ kind: 'collected'; pages: number } | { kind: 'too_many'; limit: number }> {
      const collected = await uploads.countByUser(userId);
      if (collected >= limits.images.maxPages) {
        return { kind: 'too_many', limit: limits.images.maxPages };
      }
      await uploads.add({
        userId,
        fileId: file.fileId,
        fileUniqueId: file.fileUniqueId ?? null,
        fileName: file.fileName,
        mimeType: file.mimeType ?? null,
        fileSize: file.fileSize ?? null,
        mediaGroupId: file.mediaGroupId ?? null,
      });
      return { kind: 'collected', pages: collected + 1 };
    },

    /** Файл, присланный до конца настройки расписания: вернёмся к нему, когда настройка закончится. */
    async stashFile(userId: bigint, file: IncomingFile) {
      await uploads.add({
        userId,
        fileId: file.fileId,
        fileUniqueId: file.fileUniqueId ?? null,
        fileName: file.fileName,
        mimeType: file.mimeType ?? null,
        fileSize: file.fileSize ?? null,
        mediaGroupId: file.mediaGroupId ?? null,
      });
    },

    pendingUploads: (userId: bigint): Promise<PendingUpload[]> => uploads.listByUser(userId),

    async clearUploads(userId: bigint) {
      await uploads.clear(userId);
      const dialog = await dialogs.get(userId);
      if (dialog?.flow === FLOW && dialog.step === IMAGES_STEP) await dialogs.clear(userId);
    },

    /**
     * Сообщение со счётчиком страниц: на каждую картинку альбома бот не отвечает отдельно,
     * а обновляет одно сообщение. Его номер переживает перезапуск вместе с диалогом.
     */
    async setImagesMessage(userId: bigint, messageId: number) {
      await dialogs.set(userId, { flow: FLOW, step: IMAGES_STEP, data: { messageId } });
    },

    async imagesMessage(userId: bigint): Promise<number | null> {
      const dialog = await dialogs.get(userId);
      if (dialog?.flow !== FLOW || dialog.step !== IMAGES_STEP) return null;
      const messageId = Number(dialog.data.messageId);
      return Number.isInteger(messageId) ? messageId : null;
    },

    /** Скачанные страницы альбома → текст из картинок (`sourceKind = images`). */
    async ingestImages(input: {
      userId: bigint;
      fileName: string;
      pages: readonly { tempPath: string; extension: string; fileSize: number }[];
    }): Promise<IngestResult> {
      const discard = async () => {
        for (const page of input.pages) await files.removeFile(page.tempPath);
      };
      if (input.pages.length === 0) return { kind: 'empty' };
      if (input.pages.length > limits.images.maxPages) {
        await discard();
        return {
          kind: 'too_many_pages',
          pages: input.pages.length,
          limit: limits.images.maxPages,
        };
      }

      const sha256 = await files.sha256OfMany(input.pages.map((page) => page.tempPath));
      const existing = await store.findBySha(input.userId, sha256);
      if (existing) {
        await discard();
        return { kind: 'duplicate', textId: existing.id, title: existing.title };
      }

      const text = await store.create({
        userId: input.userId,
        title: titleFromFileName(input.fileName),
        originalFileName: input.fileName,
        sourceKind: 'images',
        // Путь к каталогу страниц известен только после создания текста.
        filePath: '',
        fileSize: input.pages.reduce((total, page) => total + page.fileSize, 0),
        sha256,
        pageCount: input.pages.length,
      });
      for (const [index, page] of input.pages.entries()) {
        await files.adoptImagePage(page.tempPath, text.id, index + 1, page.extension);
      }
      await store.update(text.id, { filePath: await files.imagesDir(text.id) });
      await uploads.clear(input.userId);
      const dialog = await dialogs.get(input.userId);
      if (dialog?.flow === FLOW && dialog.step === IMAGES_STEP) await dialogs.clear(input.userId);
      enqueue(text.id, 'auto');
      return { kind: 'accepted', textId: text.id, queued: queue.pending };
    },

    /** Ответ на вопрос о неподтверждённом тексте: keep — продолжить с ним, replace — удалить и загрузить новый. */
    async choosePending(userId: bigint, token: string, choice: string): Promise<PendingChoice> {
      const dialog = await dialogs.get(userId);
      if (
        dialog?.flow !== FLOW ||
        dialog.step !== PENDING_STEP ||
        dialog.data.token !== token ||
        (choice !== 'keep' && choice !== 'replace')
      ) {
        return { kind: 'stale' };
      }
      await dialogs.clear(userId);
      const text = await ownText(userId, Number(dialog.data.textId), 'awaiting_confirm');

      if (choice === 'keep') {
        return text ? { kind: 'resume', textId: text.id, title: text.title } : { kind: 'stale' };
      }
      // Текст могли подтвердить или отменить старыми кнопками — тогда удалять нечего, просто грузим файл.
      if (text) await removeText(text);
      const file = dialog.data.file as IncomingFile;
      return { kind: 'replace', removedTitle: text?.title ?? null, file };
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
      if (!isUnitName(unit)) return { kind: 'stale' };
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
