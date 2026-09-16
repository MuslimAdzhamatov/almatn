import type { UploadsStore } from '../../app/ports.js';
import type { Db } from '../client.js';

// Присланные файлы, которые ещё не стали текстом (CLAUDE.md, раздел 4.1):
// страницы альбома до кнопки «Готово» и файлы, полученные до конца настройки расписания.

export function createUploadsRepository(db: Db): UploadsStore {
  return {
    add: (upload) => db.uploadFile.create({ data: upload }),

    listByUser: (userId) => db.uploadFile.findMany({ where: { userId }, orderBy: { id: 'asc' } }),

    countByUser: (userId) => db.uploadFile.count({ where: { userId } }),

    async clear(userId) {
      await db.uploadFile.deleteMany({ where: { userId } });
    },
  };
}
