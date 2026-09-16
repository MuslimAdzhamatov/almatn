// Интерфейсы, которые сценарии app/ ожидают от внешних слоёв (БД, файлы, poppler, Telegram).
// Реализации — в db/repositories, storage, core/pdf и delivery/bot; в тестах — подделки в памяти.

import type { PdfPageWords } from '../core/pdf/bbox.js';
import type { PixelRect } from '../core/pdf/crop.js';
import type { GrayImage, LineBox } from '../core/pdf/layout.js';
import type { NumberingAnomaly } from '../core/pdf/numbers.js';
import type { NightPolicy } from '../core/time/schedule.js';

// ——— Пользователь и диалоги ———

export interface UserSettings {
  timezone: string | null;
  dailySendTime: string | null;
  nightStart: string;
  nightEnd: string;
  nightPolicy: NightPolicy;
  eveningReminderTime: string;
  onboardedAt: Date | null;
}

export type UserSettingsPatch = Partial<Omit<UserSettings, 'onboardedAt'>> & { onboardedAt?: Date };

export interface UserSettingsStore {
  getSettings(userId: bigint): Promise<UserSettings | null>;
  updateSettings(userId: bigint, patch: UserSettingsPatch): Promise<void>;
}

/** Состояние многошагового диалога — переживает перезапуск бота. */
export interface DialogSnapshot {
  flow: string;
  step: string;
  data: Record<string, unknown>;
}

export interface DialogStore {
  get(userId: bigint): Promise<DialogSnapshot | null>;
  set(userId: bigint, dialog: DialogSnapshot): Promise<void>;
  clear(userId: bigint): Promise<void>;
}

// ——— Тексты ———

export type TextStatus = 'parsing' | 'awaiting_confirm' | 'ready' | 'failed';
export type ParseStrategy =
  'numbers' | 'text_lines' | 'image_lines' | 'paragraphs' | 'manual_page' | 'manual_split';
export type UnitName = 'lines' | 'bayts' | 'hadiths' | 'paragraphs';
/** PDF или текст из присланных картинок (страницы — файлы изображений). */
export type SourceKind = 'pdf' | 'images';

export interface ParseReport {
  firstPage: number;
  lastPage: number;
  anomalies: NumberingAnomaly[];
  /** Ни номеров, ни пригодного текстового слоя — текст разобран постранично автоматически. */
  fallbackReason?: 'no_text_layer';
}

export interface TextRecord {
  id: number;
  userId: bigint;
  title: string;
  unitName: UnitName;
  sourceKind: SourceKind;
  originalFileName: string;
  /** PDF — файл, картинки — каталог со страницами. */
  filePath: string;
  fileSize: number;
  sha256: string;
  pageCount: number;
  totalLines: number;
  parseStrategy: ParseStrategy | null;
  status: TextStatus;
  parseReport: ParseReport | null;
  parseError: string | null;
  createdAt: Date;
}

export type NewText = Pick<
  TextRecord,
  'userId' | 'title' | 'originalFileName' | 'filePath' | 'fileSize' | 'sha256' | 'pageCount'
> & { sourceKind?: SourceKind };

export type TextPatch = Partial<
  Pick<
    TextRecord,
    | 'title'
    | 'unitName'
    | 'filePath'
    | 'totalLines'
    | 'parseStrategy'
    | 'status'
    | 'parseReport'
    | 'parseError'
  >
>;

export interface TextsStore {
  countByUser(userId: bigint): Promise<number>;
  findBySha(userId: bigint, sha256: string): Promise<TextRecord | null>;
  create(data: NewText): Promise<TextRecord>;
  get(textId: number): Promise<TextRecord | null>;
  update(textId: number, patch: TextPatch): Promise<void>;
  listByStatus(status: TextStatus): Promise<TextRecord[]>;
  /** Самый старый текст пользователя в этом статусе. */
  findFirstByStatus(userId: bigint, status: TextStatus): Promise<TextRecord | null>;
  delete(textId: number): Promise<void>;
  /** Заменяет все строки текста результатом нового разбора. */
  replaceLines(textId: number, lines: readonly LineBox[]): Promise<void>;
  firstLines(textId: number, count: number): Promise<LineBox[]>;
}

// ——— Присланные файлы, которые ещё не стали текстом ———

/**
 * Файл, полученный от Telegram, но пока не разобранный: страница альбома до кнопки «Готово»
 * или файл, присланный до конца настройки расписания. Хранится только `file_id`.
 */
export interface PendingUpload {
  id: number;
  userId: bigint;
  fileId: string;
  fileUniqueId: string | null;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  /** Альбом Telegram: страницы одного текста приходят отдельными сообщениями. */
  mediaGroupId: string | null;
  createdAt: Date;
}

export type NewUpload = Omit<PendingUpload, 'id' | 'createdAt'>;

export interface UploadsStore {
  add(upload: NewUpload): Promise<PendingUpload>;
  /** Все ожидающие файлы пользователя по порядку получения. */
  listByUser(userId: bigint): Promise<PendingUpload[]>;
  countByUser(userId: bigint): Promise<number>;
  clear(userId: bigint): Promise<void>;
}

/** Файлы на диске: исходные PDF, кэш отрендеренных страниц, временные файлы. */
export interface FileStore {
  tempPath(extension: string): Promise<string>;
  /** Переносит загруженный PDF в каталог текста, возвращает новый путь. */
  adoptSource(tempPath: string, textId: number): Promise<string>;
  /** Каталог страниц текста из картинок (`texts/<id>/source`). */
  imagesDir(textId: number): Promise<string>;
  /**
   * Переносит скачанную картинку в каталог текста под номером страницы (с 1), возвращает путь.
   * Имя вида `001.jpg` — по нему страницы читаются в правильном порядке.
   */
  adoptImagePage(
    tempPath: string,
    textId: number,
    page: number,
    extension: string,
  ): Promise<string>;
  /** Пути страниц текста из картинок по порядку. */
  listImagePages(textId: number): Promise<string[]>;
  pagesDir(textId: number): Promise<string>;
  /** Временный каталог для анализа страниц — удаляется после разбора. */
  workDir(textId: number): Promise<string>;
  removeDir(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  removeText(textId: number): Promise<void>;
  sha256(path: string): Promise<string>;
  /** Один хэш для нескольких файлов по порядку — текст из картинок узнаётся по всему альбому. */
  sha256OfMany(paths: readonly string[]): Promise<string>;
  /**
   * Удаляет мусор, оставшийся после падения процесса: загрузки в tmp/ и каталоги анализа work-*.
   * Вызывается при старте, до приёма сообщений и возобновления разборов.
   */
  cleanupStale(): Promise<{ tmpFiles: number; workDirs: number }>;
}

/** poppler + sharp. Ошибки чтения PDF — PdfToolError (core/pdf/poppler). */
export interface PdfTools {
  info(file: string): Promise<{ pages: number }>;
  words(file: string): Promise<PdfPageWords[]>;
  render(
    file: string,
    options: { outDir: string; dpi: number; gray?: boolean; firstPage?: number; lastPage?: number },
  ): Promise<Map<number, string>>;
  /** Страница в цвете из кэша; рендерит, если её ещё нет. */
  renderPage(file: string, options: { outDir: string; dpi: number; page: number }): Promise<string>;
  loadGray(path: string): Promise<GrayImage>;
  imageSize(path: string): Promise<{ width: number; height: number }>;
  crop(path: string, rect: PixelRect): Promise<Buffer>;
}
