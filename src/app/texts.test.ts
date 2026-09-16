import { describe, expect, it } from 'vitest';
import type { PdfPageWords } from '../core/pdf/bbox.js';
import type { LineBox } from '../core/pdf/layout.js';
import { PdfToolError } from '../core/pdf/poppler.js';
import type {
  DialogSnapshot,
  DialogStore,
  FileStore,
  PdfTools,
  TextRecord,
  TextsStore,
} from './ports.js';
import { createTexts, titleFromFileName, type ParseEvent } from './texts.js';

const USER = 7n;
const OTHER_USER = 8n;

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

function numberedPage(page: number, numbers: number[]): PdfPageWords {
  return {
    page,
    width: 595,
    height: 842,
    words: numbers.map((n, i) => ({
      text: `(${n})`,
      xMin: 523,
      xMax: 543,
      yMin: 30 + i * 30,
      yMax: 55 + i * 30,
    })),
  };
}

const blankPage = (page: number): PdfPageWords => ({ page, width: 595, height: 842, words: [] });

function setup() {
  const pdf: {
    pages: number;
    words: PdfPageWords[];
    infoError?: PdfToolError;
    wordsError?: Error;
    sha?: string;
  } = { pages: 2, words: [numberedPage(1, range(1, 8)), blankPage(2)] };

  const texts = new Map<number, TextRecord>();
  const lines = new Map<number, LineBox[]>();
  let nextId = 1;
  const store: TextsStore = {
    countByUser: async (userId) => [...texts.values()].filter((t) => t.userId === userId).length,
    findBySha: async (userId, sha) =>
      [...texts.values()].find((t) => t.userId === userId && t.sha256 === sha) ?? null,
    create: async (data) => {
      const text: TextRecord = {
        ...data,
        id: nextId++,
        unitName: 'lines',
        sourceKind: 'pdf',
        totalLines: 0,
        parseStrategy: null,
        status: 'parsing',
        parseReport: null,
        parseError: null,
        createdAt: new Date(),
      };
      texts.set(text.id, text);
      return { ...text };
    },
    get: async (id) => (texts.has(id) ? { ...texts.get(id)! } : null),
    update: async (id, patch) => {
      Object.assign(texts.get(id)!, patch);
    },
    listByStatus: async (status) => [...texts.values()].filter((t) => t.status === status),
    findFirstByStatus: async (userId, status) =>
      [...texts.values()].find((t) => t.userId === userId && t.status === status) ?? null,
    delete: async (id) => {
      texts.delete(id);
      lines.delete(id);
    },
    replaceLines: async (id, boxes) => {
      lines.set(id, [...boxes]);
    },
    firstLines: async (id, count) => (lines.get(id) ?? []).slice(0, count),
  };

  const dialogByUser = new Map<bigint, DialogSnapshot>();
  const dialogs: DialogStore = {
    get: async (userId) => dialogByUser.get(userId) ?? null,
    set: async (userId, next) => {
      dialogByUser.set(userId, next);
    },
    clear: async (userId) => {
      dialogByUser.delete(userId);
    },
  };

  const removed: string[] = [];
  let temp = 0;
  const files: FileStore = {
    tempPath: async (ext) => `/tmp/upload-${++temp}${ext}`,
    adoptSource: async (_path, id) => `/data/texts/${id}/source.pdf`,
    pagesDir: async (id) => `/data/texts/${id}/pages`,
    workDir: async (id) => `/data/texts/${id}/work`,
    removeDir: async (path) => {
      removed.push(path);
    },
    removeFile: async (path) => {
      removed.push(path);
    },
    removeText: async (id) => {
      removed.push(`text:${id}`);
    },
    sha256: async (path) => pdf.sha ?? `sha-of-${path}`,
    cleanupStale: async () => ({ tmpFiles: 0, workDirs: 0 }),
  };

  const tools: PdfTools = {
    info: async () => {
      if (pdf.infoError) throw pdf.infoError;
      return { pages: pdf.pages };
    },
    words: async () => {
      if (pdf.wordsError) throw pdf.wordsError;
      return pdf.words;
    },
    render: async (_file, options) =>
      new Map(
        range(options.firstPage ?? 1, options.lastPage ?? pdf.pages).map((p) => [p, `gray-${p}`]),
      ),
    renderPage: async (_file, options) => `page-${options.page}`,
    loadGray: async () => ({
      width: 827,
      height: 1170,
      data: new Uint8Array(827 * 1170).fill(255),
    }),
    imageSize: async () => ({ width: 1654, height: 2339 }),
    crop: async (_path, rect) => Buffer.from(JSON.stringify(rect)),
  };

  const errors: unknown[] = [];
  let tokens = 0;
  const service = createTexts({
    store,
    dialogs,
    files,
    tools,
    reportError: (err) => errors.push(err),
    newToken: () => `t${++tokens}`,
  });
  const events: ParseEvent[] = [];
  service.onParseEvent((event) => {
    events.push(event);
  });

  async function upload(fileName = 'manzuma_fiqh.pdf') {
    const result = await service.ingest({
      userId: USER,
      fileName,
      fileSize: 1000,
      tempPath: await files.tempPath('.pdf'),
    });
    await service.idle();
    return result;
  }

  return {
    pdf,
    texts,
    lines,
    service,
    events,
    removed,
    errors,
    upload,
    getDialog: () => dialogByUser.get(USER) ?? null,
  };
}

const incoming = (fileName: string, mimeType?: string, fileSize = 1000) => ({
  fileId: `file-${fileName}`,
  fileName,
  mimeType,
  fileSize,
});

describe('проверка до скачивания', () => {
  it('принимает только PDF в пределах лимитов', async () => {
    const { service, texts } = setup();
    const check = (fileName: string, mimeType?: string, fileSize = 1000) =>
      service.checkUpload(USER, incoming(fileName, mimeType, fileSize));

    expect(await check('text.pdf')).toEqual({ kind: 'ok' });
    expect(await check('scan', 'application/pdf')).toEqual({ kind: 'ok' });
    expect(await check('notes.docx', 'application/msword')).toEqual({ kind: 'not_pdf' });
    expect(await check('big.pdf', undefined, 21 * 1024 * 1024)).toEqual({
      kind: 'too_big',
      limitMb: 20,
    });

    for (let i = 0; i < 10; i++)
      await service.ingest({
        userId: USER,
        fileName: `t${i}.pdf`,
        fileSize: 1,
        tempPath: `/tmp/${i}`,
      });
    await service.idle();
    for (const text of texts.values()) text.status = 'ready';
    expect(await check('eleventh.pdf')).toEqual({ kind: 'too_many_texts', limit: 10 });
  });
});

describe('неподтверждённый текст при загрузке нового файла', () => {
  it('разбор ещё идёт — не спрашиваем', async () => {
    const { service, upload, texts } = setup();
    await upload('a.pdf');
    texts.get(1)!.status = 'parsing';
    expect(await service.checkUpload(USER, incoming('b.pdf'))).toEqual({ kind: 'ok' });
  });

  it('спрашивает раньше лимита текстов и запоминает файл в диалоге', async () => {
    const { service, upload, texts, getDialog } = setup();
    await upload('first.pdf');
    for (let i = 2; i <= 10; i++)
      texts.set(100 + i, { ...texts.get(1)!, id: 100 + i, status: 'ready' });

    expect(await service.checkUpload(USER, incoming('second.pdf', 'application/pdf'))).toEqual({
      kind: 'pending_confirm',
      textId: 1,
      title: 'first',
      token: 't1',
    });
    expect(getDialog()).toEqual({
      flow: 'upload',
      step: 'pending_choice',
      data: {
        token: 't1',
        textId: 1,
        file: {
          fileId: 'file-second.pdf',
          fileName: 'second.pdf',
          mimeType: 'application/pdf',
          fileSize: 1000,
        },
      },
    });
    // Чужой пользователь неподтверждённого текста не видит.
    expect(await service.checkUpload(OTHER_USER, incoming('x.pdf'))).toEqual({ kind: 'ok' });
  });

  it('«Продолжить с …» — текст остаётся, сводка доступна, кнопки больше не работают', async () => {
    const { service, upload, texts, getDialog } = setup();
    await upload('first.pdf');
    await service.checkUpload(USER, incoming('second.pdf'));

    expect(await service.choosePending(OTHER_USER, 't1', 'keep')).toEqual({ kind: 'stale' });
    expect(await service.choosePending(USER, 't1', 'keep')).toEqual({
      kind: 'resume',
      textId: 1,
      title: 'first',
    });
    expect(texts.size).toBe(1);
    expect(await service.summary(1)).toMatchObject({ textId: 1, totalLines: 8 });
    expect(getDialog()).toBeNull();
    expect(await service.choosePending(USER, 't1', 'replace')).toEqual({ kind: 'stale' });
  });

  it('«Удалить и загрузить новый» — текст и файлы удалены, возвращается сохранённый файл', async () => {
    const { service, upload, texts, removed } = setup();
    await upload('first.pdf');
    await service.checkUpload(USER, incoming('second.pdf'));

    expect(await service.choosePending(USER, 't1', 'replace')).toEqual({
      kind: 'replace',
      removedTitle: 'first',
      file: { fileId: 'file-second.pdf', fileName: 'second.pdf', fileSize: 1000 },
    });
    expect(texts.size).toBe(0);
    expect(removed).toContain('text:1');
    expect(await service.checkUpload(USER, incoming('second.pdf'))).toEqual({ kind: 'ok' });
    expect(await service.choosePending(USER, 't1', 'replace')).toEqual({ kind: 'stale' });
  });

  it('кнопки предыдущего вопроса неактуальны после нового файла', async () => {
    const { service, upload } = setup();
    await upload('first.pdf');
    await service.checkUpload(USER, incoming('second.pdf'));
    await service.checkUpload(USER, incoming('third.pdf'));
    expect(await service.choosePending(USER, 't1', 'replace')).toEqual({ kind: 'stale' });
    expect(await service.choosePending(USER, 't2', 'replace')).toMatchObject({
      kind: 'replace',
      file: { fileName: 'third.pdf' },
    });
  });

  it('текст успели подтвердить старыми кнопками — он не удаляется', async () => {
    const { service, upload, texts } = setup();
    await upload('first.pdf');
    await service.checkUpload(USER, incoming('second.pdf'));
    texts.get(1)!.status = 'ready';

    expect(await service.choosePending(USER, 't1', 'replace')).toEqual({
      kind: 'replace',
      removedTitle: null,
      file: { fileId: 'file-second.pdf', fileName: 'second.pdf', fileSize: 1000 },
    });
    expect(texts.get(1)?.status).toBe('ready');
  });

  it('«Продолжить с …» для уже сохранённого текста — кнопка неактуальна', async () => {
    const { service, upload, texts } = setup();
    await upload('first.pdf');
    await service.checkUpload(USER, incoming('second.pdf'));
    texts.get(1)!.status = 'ready';
    expect(await service.choosePending(USER, 't1', 'keep')).toEqual({ kind: 'stale' });
  });
});

describe('загрузка и разбор', () => {
  it('разбирает PDF по номерам и сообщает о готовности сводки', async () => {
    const { upload, texts, lines, events, service, removed } = setup();
    const result = await upload();
    expect(result).toMatchObject({ kind: 'accepted', textId: 1 });

    expect(texts.get(1)).toMatchObject({
      title: 'manzuma fiqh',
      filePath: '/data/texts/1/source.pdf',
      status: 'awaiting_confirm',
      parseStrategy: 'numbers',
      totalLines: 8,
      parseReport: { firstPage: 1, lastPage: 1, anomalies: [] },
    });
    expect(lines.get(1)?.map((l) => l.lineNumber)).toEqual(range(1, 8));
    expect(events).toEqual([{ kind: 'parsed', userId: USER, textId: 1 }]);
    expect(removed).toContain('/data/texts/1/work');

    const preview = await service.previewImages(1);
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ page: 1, lineStart: 1, lineEnd: 5 });
  });

  it('без номеров строк — постранично, с объяснением причины', async () => {
    const { upload, pdf, texts, service } = setup();
    pdf.words = [blankPage(1), blankPage(2)];
    await upload();
    expect(texts.get(1)).toMatchObject({
      parseStrategy: 'manual_page',
      totalLines: 2,
      parseReport: { fallbackReason: 'no_numbers' },
    });
    expect(await service.previewImages(1)).toHaveLength(1);
  });

  it('PDF с паролем, повреждённый, пустой, слишком длинный — не сохраняется', async () => {
    const { upload, pdf, texts, removed } = setup();

    pdf.infoError = new PdfToolError('PDF защищён паролем', 'password');
    expect(await upload()).toEqual({ kind: 'password' });
    pdf.infoError = new PdfToolError('битый', 'damaged');
    expect(await upload()).toEqual({ kind: 'damaged' });
    delete pdf.infoError;

    pdf.pages = 0;
    expect(await upload()).toEqual({ kind: 'empty' });
    pdf.pages = 501;
    expect(await upload()).toEqual({ kind: 'too_many_pages', pages: 501, limit: 500 });

    expect(texts.size).toBe(0);
    expect(removed).toEqual([
      '/tmp/upload-1.pdf',
      '/tmp/upload-2.pdf',
      '/tmp/upload-3.pdf',
      '/tmp/upload-4.pdf',
    ]);
  });

  it('повторная загрузка того же файла — ссылка на существующий текст', async () => {
    const { upload, pdf, texts } = setup();
    pdf.sha = 'same';
    await upload('first.pdf');
    expect(await upload('copy.pdf')).toEqual({ kind: 'duplicate', textId: 1, title: 'first' });
    expect(texts.size).toBe(1);
  });

  it('ошибка разбора — текст и файлы удаляются, пользователю уходит причина', async () => {
    const { upload, pdf, texts, events, removed } = setup();
    pdf.wordsError = new PdfToolError('pdftotext упал', 'damaged');
    await upload('broken.pdf');
    expect(texts.size).toBe(0);
    expect(removed).toContain('text:1');
    expect(events).toEqual([
      { kind: 'failed', userId: USER, fileName: 'broken.pdf', reason: 'damaged' },
    ]);
  });

  it('незавершённые разборы запускаются заново после перезапуска', async () => {
    const { service, texts, upload } = setup();
    await upload();
    texts.get(1)!.status = 'parsing';
    await service.resumeParsing();
    await service.idle();
    expect(texts.get(1)?.status).toBe('awaiting_confirm');
  });
});

describe('подтверждение разбора', () => {
  it('«Всё верно» → название текстом → текст готов', async () => {
    const { upload, service, texts, getDialog } = setup();
    await upload();

    expect(await service.confirm(USER, 1)).toEqual({
      kind: 'ask_title',
      textId: 1,
      defaultTitle: 'manzuma fiqh',
    });
    expect(getDialog()).toMatchObject({ flow: 'upload', step: 'title', data: { textId: 1 } });

    expect(await service.handleTitleText(USER, '   ')).toEqual({
      kind: 'invalid_title',
      maxLength: 100,
    });
    expect(await service.handleTitleText(USER, 'منظومة في أحكام الفقه')).toMatchObject({
      kind: 'saved',
      title: 'منظومة في أحكام الفقه',
      totalLines: 8,
    });
    expect(texts.get(1)).toMatchObject({ status: 'ready', title: 'منظومة في أحكام الفقه' });
    expect(getDialog()).toBeNull();
    expect(await service.handleTitleText(USER, 'ещё текст')).toBeNull();
  });

  it('«Оставить название» берёт имя файла', async () => {
    const { upload, service, texts } = setup();
    await upload('sollam_wosol.pdf');
    expect(await service.keepTitle(USER, 1)).toMatchObject({
      kind: 'saved',
      title: 'sollam wosol',
    });
    expect(texts.get(1)?.status).toBe('ready');
  });

  it('переключение «строки / бейты» и защита от чужих и старых кнопок', async () => {
    const { upload, service, texts } = setup();
    await upload();
    expect(await service.setUnit(USER, 1, 'bayts')).toMatchObject({
      kind: 'unit_changed',
      summary: { unitName: 'bayts' },
    });
    expect(texts.get(1)?.unitName).toBe('bayts');
    expect(await service.setUnit(OTHER_USER, 1, 'lines')).toEqual({ kind: 'stale' });
    expect(await service.setUnit(USER, 1, 'verses')).toEqual({ kind: 'stale' });

    await service.keepTitle(USER, 1);
    expect(await service.confirm(USER, 1)).toEqual({ kind: 'stale' });
  });

  it('«Разобрать постранично» пересобирает строки', async () => {
    const { upload, service, texts, events } = setup();
    await upload();
    expect(await service.reparse(USER, 1, 'manual_page')).toEqual({ kind: 'reparsing', textId: 1 });
    await service.idle();
    expect(texts.get(1)).toMatchObject({
      status: 'awaiting_confirm',
      parseStrategy: 'manual_page',
      totalLines: 2,
    });
    expect(texts.get(1)?.parseReport?.fallbackReason).toBeUndefined();
    expect(events).toHaveLength(2);
  });

  it('«Отмена» удаляет текст и файлы', async () => {
    const { upload, service, texts, removed, getDialog } = setup();
    await upload();
    await service.confirm(USER, 1);
    expect(await service.cancel(USER, 1)).toEqual({ kind: 'cancelled' });
    expect(texts.size).toBe(0);
    expect(removed).toContain('text:1');
    expect(getDialog()).toBeNull();
    expect(await service.cancel(USER, 1)).toEqual({ kind: 'stale' });
  });
});

describe('titleFromFileName', () => {
  it.each([
    ['manzuma_fiqh.pdf', 'manzuma fiqh'],
    ['متن عمدة الاحكام.pdf', 'متن عمدة الاحكام'],
    ['.pdf', 'Текст'],
  ])('%s → %s', (fileName, title) => {
    expect(titleFromFileName(fileName)).toBe(title);
  });
});
