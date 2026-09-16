// Интерфейсы, которые сценарии app/ ожидают от внешних слоёв (БД, файлы, poppler, Telegram).
// Реализации — в db/repositories, storage, core/pdf и delivery/bot; в тестах — подделки в памяти.

import type { PdfPageWords } from '../core/pdf/bbox.js';
import type { PixelRect } from '../core/pdf/crop.js';
import type { GrayImage, LineBox } from '../core/pdf/layout.js';
import type { NumberingAnomaly } from '../core/pdf/numbers.js';
import type { UnitRange } from '../core/srs/ranges.js';
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

/**
 * Чем и как разбирать текст — выбор пользователя в сводке («Разобрать по-другому»).
 * Хранится у текста, поэтому переразбор повторяется и после перезапуска бота.
 */
export interface ParseRequest {
  strategy: 'auto' | ParseStrategy;
  /** Для `manual_split` — сколько равных полос резать со страницы. */
  linesPerPage?: number;
  /** Диапазон страниц, обе границы включительно (с 1); не задан — весь файл. */
  pageFrom?: number;
  pageTo?: number;
}

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
  parseRequest: ParseRequest | null;
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
    | 'parseRequest'
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

// ——— Планы заучивания ———

export type PaceMode = 'deadline' | 'per_day';
export type PlanStatus = 'active' | 'learning_done' | 'completed' | 'cancelled';

/** Даты плана — местные календарные даты «ГГГГ-ММ-ДД» (core/plan/dates). */
export interface PlanRecord {
  id: number;
  textId: number;
  userId: bigint;
  lineFrom: number;
  lineTo: number;
  unitsPerDay: number;
  paceMode: PaceMode;
  startDate: string;
  deadlineDate: string | null;
  deadlineInput: string | null;
  restDays: number[];
  status: PlanStatus;
  nextLine: number;
  estimatedEndDate: string | null;
}

export type NewPlan = Omit<PlanRecord, 'id' | 'status'>;

/** Открытый план (active | learning_done) другого текста — для предупреждения о наложении. */
export interface OpenPlan extends PlanRecord {
  textTitle: string;
}

/** Неподтверждённый повтор выданной порции (кроме learn_reminder). */
export interface ScheduledReview {
  dueAt: Date;
  units: number;
}

export interface PlansStore {
  /** null — у текста уже есть открытый план (частичный уникальный индекс). */
  create(plan: NewPlan): Promise<PlanRecord | null>;
  findOpenByText(textId: number): Promise<PlanRecord | null>;
  listOpenByUser(userId: bigint): Promise<OpenPlan[]>;
  /** Повторы пользователя со статусом pending | sent | missed, кроме плана этого текста. */
  scheduledReviews(userId: bigint, exceptTextId: number): Promise<ScheduledReview[]>;
}

// ——— Выдача порций и повторы (этап 5) ———

/** Кэш Telegram file_id для одинаковых вырезок. */
export interface CropCacheStore {
  get(textId: number, keys: readonly string[]): Promise<Map<string, string>>;
  save(textId: number, entries: readonly { cacheKey: string; fileId: string }[]): Promise<void>;
}

export type ReviewStageName =
  'learn_reminder' | 'rep_12h' | 'rep_1d' | 'rep_3d' | 'rep_2w' | 'rep_1m';
export type ReviewStatusName = 'pending' | 'sent' | 'confirmed' | 'missed' | 'cancelled';
export type PortionStatusName = 'sent' | 'learned' | 'completed';
export type DeliveryKindName =
  'portion' | 'review_batch' | 'debt_reminder' | 'learn_reminder' | 'pause_ending' | 'autopause';
export type DeliveryStatusName =
  'sending' | 'sent' | 'confirmed' | 'missed' | 'failed' | 'replaced';

/** Настройки пользователя, нужные планировщику. */
export interface LearnerSettings {
  userId: bigint;
  timezone: string;
  dailySendTime: string;
  eveningReminderTime: string;
  nightStart: string;
  nightEnd: string;
  nightPolicy: NightPolicy;
  learnReminderDelayMin: number;
  pausedFrom: Date | null;
  pausedUntil: Date | null;
  blockedAt: Date | null;
  /** Последнее нажатие или команда; до первого — момент регистрации. */
  lastActivityAt: Date;
}

/** Текст плана — то, что нужно для подписей и картинок. */
export interface PlanText {
  id: number;
  title: string;
  unitName: UnitName;
  parseStrategy: ParseStrategy;
  sourceKind: SourceKind;
  filePath: string;
  totalLines: number;
}

export interface PlanContext {
  plan: PlanRecord;
  text: PlanText;
  user: LearnerSettings;
}

export interface PortionRecord {
  id: number;
  planId: number;
  seq: number;
  lineStart: number;
  lineEnd: number;
  status: PortionStatusName;
  sentAt: Date;
  learnedAt: Date | null;
  anchorAt: Date | null;
}

export interface DeliveryRecord {
  id: number;
  userId: bigint;
  textId: number | null;
  portionId: number | null;
  kind: DeliveryKindName;
  status: DeliveryStatusName;
  slotAt: Date;
  messageIds: number[];
  buttonsMessageId: number | null;
  cropMarginSteps: number;
  extraBefore: number;
  extraAfter: number;
}

export interface UnitRow {
  lineNumber: number;
  skipped: boolean;
}

/** Повтор вместе с границами его порции. */
export interface ReviewRow {
  id: number;
  portionId: number;
  dueAt: Date;
  status: ReviewStatusName;
  lineStart: number;
  lineEnd: number;
}

export const BATCH_KINDS = ['review_batch', 'debt_reminder'] as const satisfies DeliveryKindName[];

/** Единица с координатами и признаком пропуска. */
export type UnitBox = LineBox & { skipped: boolean };

export interface NewPortion {
  planId: number;
  seq: number;
  lineStart: number;
  lineEnd: number;
  sentAt: Date;
  /** Ожидаемый Plan.nextLine: если план успели изменить, порция не создаётся. */
  expectedNextLine: number;
  nextLine: number;
  learnReminderAt: Date;
  delivery: { userId: bigint; textId: number; slotAt: Date; dedupeKey: string };
}

export interface DueLearnReminder {
  reviewId: number;
  dueAt: Date;
  portion: PortionRecord;
  context: PlanContext;
}

export interface LearningStore {
  /** Выполняет fn под advisory lock; null — блокировку держит другой тик. */
  withTickLock<T>(fn: () => Promise<T>): Promise<T | null>;
  listActivePlans(): Promise<PlanContext[]>;
  /** Планы, по которым ещё идут порции или повторы (active | learning_done). */
  listOpenPlans(): Promise<PlanContext[]>;
  planContext(planId: number): Promise<PlanContext | null>;
  /** Открытый план текста. */
  textPlanContext(textId: number): Promise<PlanContext | null>;
  lastPortion(planId: number): Promise<PortionRecord | null>;
  getPortion(portionId: number): Promise<PortionRecord | null>;
  /** Невыученная порция плана (статус sent), если есть. */
  unlearnedPortion(planId: number): Promise<PortionRecord | null>;
  /** Неподтверждённые повторы (pending | sent | missed, без learn_reminder) всех порций текста. */
  textReviews(textId: number): Promise<ReviewRow[]>;
  /** Повторы, последняя отправка которых — deliveryId (в любом статусе). */
  deliveryReviews(deliveryId: number): Promise<ReviewRow[]>;
  /** Повторы попали в отправку: статус sent, deliveryId перезаписывается. */
  attachReviews(deliveryId: number, reviewIds: readonly number[], at: Date): Promise<void>;
  /**
   * Ответ на сводку: confirmed — повторы отправки в статусе sent | missed,
   * missed — в статусе sent. Возвращает, сколько повторов изменилось.
   */
  answerReviews(deliveryId: number, answer: 'confirmed' | 'missed', at: Date): Promise<number>;
  /**
   * Порции плана с подтверждённым rep_1m → completed; план в learning_done, у которого закрыты
   * все порции, → completed. true — план закрыт этим вызовом.
   */
  completePortions(planId: number, at: Date): Promise<boolean>;
  /** Сводки текста, у которых ещё есть кнопки (sent). */
  openBatchDeliveries(textId: number): Promise<DeliveryRecord[]>;
  unitRows(textId: number, from: number, to: number): Promise<UnitRow[]>;
  unitBoxes(textId: number, from: number, to: number): Promise<UnitBox[]>;
  /** Порция + learn_reminder + запись об отправке + сдвиг nextLine одной транзакцией; null — гонка. */
  createPortion(
    portion: NewPortion,
  ): Promise<{ portion: PortionRecord; deliveryId: number } | null>;
  /** Отправка не удалась: порция удаляется, nextLine возвращается. */
  rollbackPortion(portionId: number, nextLine: number): Promise<void>;
  /** Новая запись об отправке; null — такой dedupeKey уже есть. */
  createDelivery(delivery: {
    userId: bigint;
    textId: number | null;
    portionId: number | null;
    kind: DeliveryKindName;
    slotAt: Date;
    dedupeKey: string;
  }): Promise<number | null>;
  markDeliverySent(
    deliveryId: number,
    messageIds: number[],
    buttonsMessageId: number | null,
    at: Date,
  ): Promise<void>;
  setDeliveryStatus(deliveryId: number, status: DeliveryStatusName, at?: Date): Promise<void>;
  deleteDelivery(deliveryId: number): Promise<void>;
  getDelivery(deliveryId: number): Promise<DeliveryRecord | null>;
  /** Поля кнопок контекста. */
  updateDeliveryContext(
    deliveryId: number,
    patch: Partial<Pick<DeliveryRecord, 'cropMarginSteps' | 'extraBefore' | 'extraAfter'>>,
  ): Promise<void>;
  /** Сообщения порции и напоминания о ней, у которых ещё есть кнопки (sent); сводки не входят. */
  openPortionDeliveries(portionId: number): Promise<DeliveryRecord[]>;
  countPortionDeliveries(portionId: number): Promise<number>;
  /**
   * «Выучил»: sent → learned, learn_reminder отменяется, создаются повторы. false — порция уже не sent.
   */
  markLearned(
    portionId: number,
    learnedAt: Date,
    anchorAt: Date,
    reviews: readonly { stage: ReviewStageName; dueAt: Date }[],
  ): Promise<boolean>;
  cancelLearnReminder(portionId: number): Promise<void>;
  /** «Напомнить позже»: learn_reminder снова pending с новым сроком. */
  rescheduleLearnReminder(portionId: number, dueAt: Date): Promise<void>;
  dueLearnReminders(now: Date): Promise<DueLearnReminder[]>;
  /** pending → sent; false — напоминание уже взято. */
  claimLearnReminder(reviewId: number): Promise<boolean>;
  releaseLearnReminder(reviewId: number): Promise<void>;
  markSkipped(textId: number, lineNumbers: readonly number[]): Promise<void>;
  /** Новые границы порции после пропуска. */
  updatePortionRange(portionId: number, lineStart: number, lineEnd: number): Promise<void>;
  deletePortion(portionId: number): Promise<void>;
  updatePlan(
    planId: number,
    patch: Partial<Pick<PlanRecord, 'nextLine' | 'estimatedEndDate' | 'status'>>,
  ): Promise<void>;
  countUnits(textId: number, from: number, to: number): Promise<number>;
  setBlocked(userId: bigint, at: Date): Promise<void>;
  /** Пауза пользователя: until = null — до ручного продолжения; from = null — паузы нет. */
  setPause(userId: bigint, from: Date | null, until: Date | null): Promise<void>;
}

/** Картинка к отправке — уже известный Telegram file_id или PNG; подпись — по номерам единиц. */
export interface NotifierPicture {
  fileId: string | null;
  png: Buffer | null;
  lineStart: number;
  lineEnd: number;
}

/** Как называть единицы в подписях. */
export interface UnitLabel {
  unitName: UnitName;
  strategy: ParseStrategy;
}

export type SendResult =
  | {
      ok: true;
      messageIds: number[];
      buttonsMessageId: number | null;
      /** file_id отправленных картинок по порядку (null — не удалось узнать). */
      fileIds: (string | null)[];
    }
  | { ok: false; reason: 'blocked' | 'error'; error: unknown };

export interface PortionView extends UnitLabel {
  deliveryId: number;
  title: string;
  lineStart: number;
  lineEnd: number;
  /** Сколько единиц порции (без пропущенных). */
  count: number;
  /** Порция пришла взамен пропущенной. */
  replaced: boolean;
}

export type BatchKind = 'review' | 'debt' | 'evening';

/** Что сейчас показывать под сводкой: отметка повторов и «Выучил» — пока есть на что отвечать. */
export interface BatchButtons {
  confirm: boolean;
  learn: UnitRange | null;
}

/** Сводный повтор или напоминание о долге по одному тексту. */
export interface BatchView extends UnitLabel {
  deliveryId: number;
  title: string;
  kind: BatchKind;
  /** Объединённые диапазоны повторов. */
  reviews: UnitRange[];
  /** Невыученная порция. */
  portion: UnitRange | null;
  buttons: BatchButtons;
}

/**
 * Отправка сообщений пользователю. Сценарии и планировщик не знают про Telegram —
 * реализация в delivery/bot/notifier.ts.
 */
export interface Notifier {
  sendPortion(
    userId: bigint,
    view: PortionView,
    pictures: readonly NotifierPicture[],
  ): Promise<SendResult>;
  sendLearnReminder(userId: bigint, view: PortionView): Promise<SendResult>;
  /** Сводный повтор / напоминание о долге: картинки, затем сообщение с кнопками. */
  sendBatch(
    userId: bigint,
    view: BatchView,
    pictures: readonly NotifierPicture[],
  ): Promise<SendResult>;
  /** Дополнительные картинки (кнопки контекста). */
  sendPictures(
    userId: bigint,
    unit: UnitLabel,
    pictures: readonly NotifierPicture[],
  ): Promise<SendResult>;
  sendText(userId: bigint, text: string): Promise<SendResult>;
  /** Автопауза: сообщение с кнопкой «Продолжить». */
  sendAutoPause(userId: bigint): Promise<SendResult>;
  /** Убрать кнопки под сообщением (порция заменена, план закончился). */
  clearButtons(userId: bigint, messageId: number): Promise<void>;
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
