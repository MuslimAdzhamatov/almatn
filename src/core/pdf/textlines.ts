import type { PdfPageWords, PdfWord } from './bbox.js';
import type { Fragment, LineBox } from './layout.js';

// Стратегия «по строкам текстового слоя» (CLAUDE.md, раздел 4.1, стратегия 2):
// номеров нет, но координаты слов есть — строки собираются из слов, нумерует бот сам.
// Границы вырезки потом уточняются по пикселям (layoutNumberedLines), как и у разбора по номерам.

export interface TextLine {
  page: number;
  yMin: number;
  yMax: number;
  xMin: number;
  xMax: number;
  /** Сколько слов попало в строку — по нему отличается колонтитул от текста. */
  words: number;
}

export interface TextLinesParse {
  /** Строки текста по порядку; нумерация сквозная через весь документ. */
  lines: TextLine[];
  /** Заголовки разделов: каждый привязан к строке с этим номером (первой после него). */
  headings: { beforeLine: number; line: TextLine }[];
  firstPage: number;
  lastPage: number;
}

export interface TextLinesOptions {
  /** Доля меньшей высоты, на которую должны перекрыться слова, чтобы попасть в одну строку. */
  minOverlap: number;
  /** Строка выше обычной во столько раз — заголовок раздела. */
  headingHeightRatio: number;
  /** Полоса у верхнего и нижнего края страницы, где ищутся колонтитулы (доля высоты). */
  marginBand: number;
  /** На какой доле страниц должна повторяться строка на той же высоте, чтобы счесть её колонтитулом. */
  repeatShare: number;
  /**
   * Колонтитул узкий: номер страницы или название книги занимают малую часть ширины текста.
   * Без этого признака первая строка страницы, которая тоже стоит у края и на той же высоте,
   * принималась бы за колонтитул.
   */
  maxRunningWidth: number;
  /** Разброс высоты колонтитула между страницами (пункты), в пределах которого он считается тем же. */
  runningTolerance: number;
  /** Страница считается страницей текста, если строк на ней не меньше этой доли от обычного. */
  pageFullness: number;
  /** Меньше строк во всём документе — результат неправдоподобен. */
  minLines: number;
  /**
   * Доля «заголовков» среди строк, после которой текстовый слой считается сломанным.
   * У PDF с битыми шрифтами (`متن عمدة الاحكام.pdf`) высоты слов скачут, и заголовком
   * выглядит больше половины строк; такой текст надо разбирать по изображению.
   */
  maxHeadingShare: number;
}

const DEFAULTS: TextLinesOptions = {
  minOverlap: 0.5,
  headingHeightRatio: 1.35,
  marginBand: 0.12,
  repeatShare: 0.5,
  maxRunningWidth: 0.5,
  runningTolerance: 6,
  pageFullness: 0.4,
  minLines: 10,
  maxHeadingShare: 0.35,
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Слова страницы → строки. Слово присоединяется к строке, если их вертикальные интервалы
 * перекрываются: огласовки и мелкие знаки идут в текстовом слое отдельными словами со смещением.
 */
export function groupWordsIntoLines(
  page: PdfPageWords,
  minOverlap = DEFAULTS.minOverlap,
): TextLine[] {
  const words = [...page.words]
    .filter((word) => word.text.trim() !== '' && word.yMax > word.yMin)
    .sort((a, b) => a.yMin - b.yMin);

  const lines: TextLine[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last && overlaps(word, last, minOverlap)) {
      last.yMin = Math.min(last.yMin, word.yMin);
      last.yMax = Math.max(last.yMax, word.yMax);
      last.xMin = Math.min(last.xMin, word.xMin);
      last.xMax = Math.max(last.xMax, word.xMax);
      last.words += 1;
    } else {
      lines.push({
        page: page.page,
        yMin: word.yMin,
        yMax: word.yMax,
        xMin: word.xMin,
        xMax: word.xMax,
        words: 1,
      });
    }
  }
  return lines;
}

function overlaps(word: PdfWord, line: TextLine, minOverlap: number): boolean {
  const overlap = Math.min(word.yMax, line.yMax) - Math.max(word.yMin, line.yMin);
  const smaller = Math.min(word.yMax - word.yMin, line.yMax - line.yMin);
  return overlap >= minOverlap * smaller;
}

/**
 * Колонтитулы: строка у края страницы, которая повторяется на той же высоте на большинстве страниц
 * (номер страницы, название книги в верхнем поле). Сноски под чертой так не отсекаются — они разные.
 */
export function findRunningLines(
  pages: readonly { page: number; height: number; lines: readonly TextLine[] }[],
  options: Pick<
    TextLinesOptions,
    'marginBand' | 'repeatShare' | 'maxRunningWidth' | 'runningTolerance'
  > = DEFAULTS,
): Set<TextLine> {
  const all = pages.flatMap((page) => page.lines);
  if (all.length === 0) return new Set();
  const widthLimit = median(all.map((line) => line.xMax - line.xMin)) * options.maxRunningWidth;

  const bands = { top: [] as TextLine[], bottom: [] as TextLine[] };
  for (const page of pages) {
    const band = page.height * options.marginBand;
    for (const line of page.lines) {
      const atTop = line.yMax <= band;
      const atBottom = line.yMin >= page.height - band;
      if (!atTop && !atBottom) continue;
      if (line.xMax - line.xMin > widthLimit) continue;
      bands[atTop ? 'top' : 'bottom'].push(line);
    }
  }

  // Высота колонтитула гуляет на пункт-другой от страницы к странице, поэтому строки
  // собираются в кластер по близости, а не раскладываются по корзинам фиксированного шага.
  const needed = Math.max(3, Math.ceil(pages.length * options.repeatShare));
  const running = new Set<TextLine>();
  for (const band of [bands.top, bands.bottom]) {
    const sorted = [...band].sort((a, b) => a.yMin - b.yMin);
    let cluster: TextLine[] = [];
    const flush = () => {
      if (new Set(cluster.map((line) => line.page)).size >= needed) {
        for (const line of cluster) running.add(line);
      }
      cluster = [];
    };
    for (const line of sorted) {
      const previous = cluster.at(-1);
      if (previous && line.yMin - previous.yMin > options.runningTolerance) flush();
      cluster.push(line);
    }
    flush();
  }
  return running;
}

/** Строки текста по всему документу или null, если текстового слоя фактически нет. */
export function detectTextLines(
  pages: readonly PdfPageWords[],
  options: Partial<TextLinesOptions> = {},
): TextLinesParse | null {
  const opts = { ...DEFAULTS, ...options };
  const perPage = pages.map((page) => ({
    page: page.page,
    height: page.height,
    lines: groupWordsIntoLines(page, opts.minOverlap),
  }));

  const running = findRunningLines(perPage, opts);
  const withoutRunning = perPage.map((page) => ({
    ...page,
    lines: page.lines.filter((line) => !running.has(line)),
  }));

  const textPages = mainPages(withoutRunning, opts.pageFullness);
  const lines = textPages.flatMap((page) => page.lines);
  if (lines.length < opts.minLines) return null;

  const heightLimit = median(lines.map((line) => line.yMax - line.yMin)) * opts.headingHeightRatio;
  const result: TextLine[] = [];
  const headings: { beforeLine: number; line: TextLine }[] = [];
  for (const line of lines) {
    if (line.yMax - line.yMin >= heightLimit)
      headings.push({ beforeLine: result.length + 1, line });
    else result.push(line);
  }
  if (result.length < opts.minLines) return null;
  if (headings.length > lines.length * opts.maxHeadingShare) return null;

  return {
    lines: result,
    // Заголовки в самом конце документа привязывать не к чему — они отбрасываются.
    headings: headings.filter((heading) => heading.beforeLine <= result.length),
    firstPage: result[0]!.page,
    lastPage: result.at(-1)!.page,
  };
}

/**
 * Размеченные полосы → единицы заучивания: полосы-заголовки становятся фрагментами `heading`
 * у следующей за ними единицы, остальные нумеруются подряд. Заголовок, оставшийся внизу
 * предыдущей страницы, сохраняет свою страницу — вырезка сделает из него отдельную картинку.
 */
export function attachHeadings(
  boxes: readonly LineBox[],
  isHeading: readonly boolean[],
): LineBox[] {
  const units: LineBox[] = [];
  let pending: Fragment[] = [];
  boxes.forEach((box, index) => {
    if (isHeading[index]) {
      pending.push(...box.fragments.map((fragment) => ({ ...fragment, kind: 'heading' as const })));
      return;
    }
    units.push({
      ...box,
      lineNumber: units.length + 1,
      printedNumber: null,
      sectionBreakBefore: box.sectionBreakBefore || pending.length > 0,
      fragments: [...pending, ...box.fragments],
    });
    pending = [];
  });
  return units;
}

/**
 * Обложка, титул и колофон — страницы, на которых почти нет строк.
 * Берём самый длинный отрезок подряд идущих «полных» страниц: так отсекается начало и конец книги.
 */
function mainPages<T extends { lines: readonly TextLine[] }>(
  pages: readonly T[],
  fullness: number,
): T[] {
  const counts = pages.map((page) => page.lines.length).filter((count) => count > 0);
  if (counts.length === 0) return [];
  const needed = Math.max(1, median(counts) * fullness);

  let best: T[] = [];
  let current: T[] = [];
  for (const page of pages) {
    if (page.lines.length >= needed) {
      current.push(page);
      if (current.length > best.length) best = current;
    } else {
      current = [];
    }
  }
  return best;
}
