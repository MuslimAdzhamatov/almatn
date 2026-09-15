import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileStore } from '../app/ports.js';

// Файлы в DATA_DIR: texts/<id>/source.pdf, texts/<id>/pages/ (кэш страниц), tmp/ (загрузки).

export function createFileStorage(dataDir: string): FileStore {
  const root = resolve(dataDir);
  const textDir = (textId: number) => join(root, 'texts', String(textId));

  const ensure = async (dir: string) => {
    await mkdir(dir, { recursive: true });
    return dir;
  };

  return {
    async tempPath(extension) {
      return join(await ensure(join(root, 'tmp')), `${randomUUID()}${extension}`);
    },

    async adoptSource(tempPath, textId) {
      const target = join(await ensure(textDir(textId)), 'source.pdf');
      await rename(tempPath, target);
      return target;
    },

    pagesDir: (textId) => ensure(join(textDir(textId), 'pages')),

    workDir: (textId) => ensure(join(textDir(textId), `work-${randomUUID()}`)),

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
  };
}
