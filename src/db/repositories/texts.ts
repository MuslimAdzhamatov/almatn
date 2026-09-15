import type { ParseReport, TextRecord, TextsStore } from '../../app/ports.js';
import type { LineBox } from '../../core/pdf/layout.js';
import { Prisma, type Line, type Text } from '../../generated/prisma/client.js';
import type { Db } from '../client.js';

function toRecord(row: Text): TextRecord {
  // parseReport записывает только сам бот (app/texts), поэтому доверяем форме JSON.
  return { ...row, parseReport: (row.parseReport as unknown as ParseReport | null) ?? null };
}

function toBox(row: Line): LineBox {
  return {
    lineNumber: row.lineNumber,
    printedNumber: row.printedNumber,
    page: row.page,
    yTop: row.yTop,
    yBottom: row.yBottom,
    xLeft: row.xLeft,
    xRight: row.xRight,
    sectionBreakBefore: row.sectionBreakBefore,
  };
}

export function createTextsRepository(db: Db): TextsStore {
  return {
    countByUser: (userId) => db.text.count({ where: { userId } }),

    async findBySha(userId, sha256) {
      const row = await db.text.findUnique({ where: { userId_sha256: { userId, sha256 } } });
      return row ? toRecord(row) : null;
    },

    async create(data) {
      return toRecord(await db.text.create({ data }));
    },

    async get(textId) {
      const row = await db.text.findUnique({ where: { id: textId } });
      return row ? toRecord(row) : null;
    },

    async update(textId, { parseReport, ...patch }) {
      await db.text.update({
        where: { id: textId },
        data: {
          ...patch,
          ...(parseReport !== undefined && {
            parseReport:
              parseReport === null
                ? Prisma.DbNull
                : (parseReport as unknown as Prisma.InputJsonObject),
          }),
        },
      });
    },

    async listByStatus(status) {
      return (await db.text.findMany({ where: { status } })).map(toRecord);
    },

    async delete(textId) {
      await db.text.deleteMany({ where: { id: textId } });
    },

    async replaceLines(textId, lines) {
      await db.$transaction([
        db.line.deleteMany({ where: { textId } }),
        db.line.createMany({ data: lines.map((line) => ({ textId, ...line })) }),
      ]);
    },

    async firstLines(textId, count) {
      const rows = await db.line.findMany({
        where: { textId },
        orderBy: { lineNumber: 'asc' },
        take: count,
      });
      return rows.map(toBox);
    },
  };
}
