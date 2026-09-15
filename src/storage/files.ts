import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileStore } from '../app/ports.js';

// Файлы в DATA_DIR: texts/<id>/source.pdf, texts/<id>/pages/ (кэш страниц),
// texts/<id>/work-*/ (анализ во время разбора), tmp/ (загрузки до проверки).

const WORK_DIR_PREFIX = 'work-';

/** Содержимое каталога; отсутствующий каталог — пустой список. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function createFileStorage(dataDir: string): FileStore {
  const root = resolve(dataDir);
  const tmpDir = join(root, 'tmp');
  const textsDir = join(root, 'texts');
  const textDir = (textId: number) => join(textsDir, String(textId));

  const ensure = async (dir: string) => {
    await mkdir(dir, { recursive: true });
    return dir;
  };

  return {
    async tempPath(extension) {
      return join(await ensure(tmpDir), `${randomUUID()}${extension}`);
    },

    async adoptSource(tempPath, textId) {
      const target = join(await ensure(textDir(textId)), 'source.pdf');
      await rename(tempPath, target);
      return target;
    },

    pagesDir: (textId) => ensure(join(textDir(textId), 'pages')),

    workDir: (textId) => ensure(join(textDir(textId), `${WORK_DIR_PREFIX}${randomUUID()}`)),

    async removeDir(path) {
      await rm(path, { recursive: true, force: true });
    },

    async removeFile(path) {
      await rm(path, { force: true });
    },

    async removeText(textId) {
      await rm(textDir(textId), { recursive: true, force: true });
    },

    async sha256(path) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
      return hash.digest('hex');
    },

    async cleanupStale() {
      let tmpFiles = 0;
      for (const name of await listDir(tmpDir)) {
        await rm(join(tmpDir, name), { recursive: true, force: true });
        tmpFiles++;
      }
      let workDirs = 0;
      for (const textId of await listDir(textsDir)) {
        for (const name of await listDir(join(textsDir, textId))) {
          if (!name.startsWith(WORK_DIR_PREFIX)) continue;
          await rm(join(textsDir, textId, name), { recursive: true, force: true });
          workDirs++;
        }
      }
      return { tmpFiles, workDirs };
    },
  };
}
