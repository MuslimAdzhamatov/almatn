import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileStorage } from './files.js';

describe('файловое хранилище', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'almatn-files-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('при старте удаляет незавершённые загрузки и каталоги анализа, но не тексты и кэш страниц', async () => {
    await mkdir(join(dataDir, 'tmp'), { recursive: true });
    await writeFile(join(dataDir, 'tmp', 'upload-1.pdf'), 'обрыв скачивания');
    await writeFile(join(dataDir, 'tmp', 'upload-2.pdf'), 'падение при проверке');

    const text = join(dataDir, 'texts', '1');
    await mkdir(join(text, 'pages'), { recursive: true });
    await mkdir(join(text, 'work-abc'), { recursive: true });
    await writeFile(join(text, 'source.pdf'), '%PDF');
    await writeFile(join(text, 'pages', 'r200c-02.png'), 'png');
    await writeFile(join(text, 'work-abc', 'r100g-02.png'), 'png');

    const storage = createFileStorage(dataDir);
    expect(await storage.cleanupStale()).toEqual({ tmpFiles: 2, workDirs: 1 });

    expect(await readdir(join(dataDir, 'tmp'))).toEqual([]);
    expect((await readdir(text)).sort()).toEqual(['pages', 'source.pdf']);
    expect(await readdir(join(text, 'pages'))).toEqual(['r200c-02.png']);
    expect(await storage.cleanupStale()).toEqual({ tmpFiles: 0, workDirs: 0 });
  });

  it('пустой или ещё не созданный каталог данных — очищать нечего', async () => {
    expect(await createFileStorage(join(dataDir, 'missing')).cleanupStale()).toEqual({
      tmpFiles: 0,
      workDirs: 0,
    });
  });

  it('загрузка переносится в каталог текста, sha256 считается по содержимому', async () => {
    const storage = createFileStorage(dataDir);
    const temp = await storage.tempPath('.pdf');
    await writeFile(temp, 'abc');
    expect(await storage.sha256(temp)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await storage.adoptSource(temp, 5)).toBe(join(dataDir, 'texts', '5', 'source.pdf'));
    expect(await readdir(join(dataDir, 'tmp'))).toEqual([]);
  });
});
