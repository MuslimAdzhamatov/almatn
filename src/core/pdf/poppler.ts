import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseBboxXhtml, type PdfPageWords } from './bbox.js';

// Адаптер к poppler (pdfinfo, pdftotext, pdftoppm). Внешние процессы не блокируют event loop бота.

const run = promisify(execFile);

const INFO_TIMEOUT_MS = 30_000;
const TEXT_TIMEOUT_MS = 120_000;
const RENDER_TIMEOUT_MS = 300_000;

export type PdfToolFailure = 'password' | 'damaged';

export class PdfToolError extends Error {
  constructor(
    message: string,
    readonly reason: PdfToolFailure,
  ) {
    super(message);
    this.name = 'PdfToolError';
  }
}

export interface PdfInfo {
  pages: number;
  /** Есть права доступа/шифрование; документ при этом может открываться без пароля. */
  encrypted: boolean;
}

function stderrOf(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' ? stderr.trim() : '';
}

function toToolError(err: unknown, action: string): PdfToolError {
  const stderr = stderrOf(err);
  if (/password/i.test(stderr)) return new PdfToolError('PDF защищён паролем', 'password');
  return new PdfToolError(`${action}: ${stderr || String(err)}`, 'damaged');
}

export async function pdfInfo(file: string): Promise<PdfInfo> {
  let stdout: string;
  try {
    ({ stdout } = await run('pdfinfo', [file], { timeout: INFO_TIMEOUT_MS }));
  } catch (err) {
    throw toToolError(err, 'pdfinfo не смог прочитать файл');
  }
  const pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
  if (!Number.isInteger(pages))
    throw new PdfToolError('pdfinfo не вернул число страниц', 'damaged');
  return { pages, encrypted: /^Encrypted:\s+yes/m.test(stdout) };
}

/** Слова текстового слоя с координатами по всем страницам. */
export async function extractWords(file: string): Promise<PdfPageWords[]> {
  try {
    const { stdout } = await run('pdftotext', ['-q', '-bbox', file, '-'], {
      timeout: TEXT_TIMEOUT_MS,
      maxBuffer: 512 * 1024 * 1024,
    });
    return parseBboxXhtml(stdout);
  } catch (err) {
    throw toToolError(err, 'pdftotext не смог извлечь текстовый слой');
  }
}

export interface RenderOptions {
  outDir: string;
  dpi: number;
  gray?: boolean;
  firstPage?: number;
  lastPage?: number;
}

/** Рендерит диапазон страниц в PNG одним вызовом pdftoppm. Возвращает номер страницы → путь к файлу. */
export async function renderPages(
  file: string,
  options: RenderOptions,
): Promise<Map<number, string>> {
  const prefix = `r${options.dpi}${options.gray ? 'g' : 'c'}`;
  const args = ['-q', '-r', String(options.dpi), '-png'];
  if (options.gray) args.push('-gray');
  if (options.firstPage) args.push('-f', String(options.firstPage));
  if (options.lastPage) args.push('-l', String(options.lastPage));
  try {
    await run('pdftoppm', [...args, file, join(options.outDir, prefix)], {
      timeout: RENDER_TIMEOUT_MS,
    });
  } catch (err) {
    throw toToolError(err, 'pdftoppm не смог отрендерить страницы');
  }

  const first = options.firstPage ?? 1;
  const last = options.lastPage ?? Infinity;
  const pattern = new RegExp(`^${prefix}-(\\d+)\\.png$`);
  const result = new Map<number, string>();
  for (const name of await readdir(options.outDir)) {
    const page = Number(pattern.exec(name)?.[1]);
    if (page >= first && page <= last) result.set(page, join(options.outDir, name));
  }
  return result;
}

/** Одна страница в цвете из кэша outDir; рендерит, если её там ещё нет. */
export async function renderPage(
  file: string,
  options: { outDir: string; dpi: number; page: number },
): Promise<string> {
  const pattern = new RegExp(`^r${options.dpi}c-0*${options.page}\\.png$`);
  const cached = (await readdir(options.outDir)).find((name) => pattern.test(name));
  if (cached) return join(options.outDir, cached);

  const rendered = await renderPages(file, {
    outDir: options.outDir,
    dpi: options.dpi,
    firstPage: options.page,
    lastPage: options.page,
  });
  const path = rendered.get(options.page);
  if (!path) throw new PdfToolError(`Страница ${options.page} не отрендерилась`, 'damaged');
  return path;
}
