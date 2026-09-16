import type { ParseReport, TextRecord, TextsStore } from '../../app/ports.js';
import type { LineBox } from '../../core/pdf/layout.js';
import { Prisma, type Line, type LineFragment, type Text } from '../../generated/prisma/client.js';
import type { Db } from '../client.js';

function toRecord(row: Text): TextRecord {
  // parseReport записывает только сам бот (app/texts), поэтому доверяем форме JSON.
  return { ...row, parseReport: (row.parseReport as unknown as ParseReport | null) ?? null };
}

function toBox(row: Line & { fragments: LineFragment[] }): LineBox {
  return {
    lineNumber: row.lineNumber,
    printedNumber: row.printedNumber,
    page: row.page,
    sectionBreakBefore: row.sectionBreakBefore,
    fragments: [...row.fragments]
      .sort((a, b) => a.seq - b.seq)
      .map(({ kind, page, yTop, yBottom, xLeft, xRight }) => ({
        kind,
        page,
        yTop,
        yBottom,
        xLeft,
        xRight,
      })),
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

    async findFirstByStatus(userId, status) {
      const row = await db.text.findFirst({
        where: { userId, status },
        orderBy: { createdAt: 'asc' },
      });
      return row ? toRecord(row) : null;
    },

    async delete(textId) {
      await db.text.deleteMany({ where: { id: textId } });
    },

    async replaceLines(textId, lines) {
      // Фрагменты создаются вторым запросом: id строк известны только после вставки.
      await db.$transaction(async (tx) => {
        await tx.line.deleteMany({ where: { textId } });
        const created = await tx.line.createManyAndReturn({
          data: lines.map(({ lineNumber, printedNumber, page, sectionBreakBefore }) => ({
            textId,
            lineNumber,
            printedNumber,
            page,
            sectionBreakBefore,
          })),
          select: { id: true, lineNumber: true },
        });
        const idByNumber = new Map(created.map((row) => [row.lineNumber, row.id]));
        await tx.lineFragment.createMany({
          data: lines.flatMap((line) =>
            line.fragments.map((fragment, seq) => ({
              lineId: idByNumber.get(line.lineNumber)!,
              seq,
              ...fragment,
            })),
          ),
        });
      });
    },

    async firstLines(textId, count) {
      const rows = await db.line.findMany({
        where: { textId },
        orderBy: { lineNumber: 'asc' },
        take: count,
        include: { fragments: { orderBy: { seq: 'asc' } } },
      });
      return rows.map(toBox);
    },
  };
}
