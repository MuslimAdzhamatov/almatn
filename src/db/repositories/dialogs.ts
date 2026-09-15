import type { DialogSnapshot, DialogStore } from '../../app/ports.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../client.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createDialogsRepository(db: Db): DialogStore {
  return {
    async get(userId: bigint): Promise<DialogSnapshot | null> {
      const row = await db.dialogState.findUnique({ where: { userId } });
      if (!row) return null;
      return { flow: row.flow, step: row.step, data: isRecord(row.data) ? row.data : {} };
    },

    async set(userId: bigint, { flow, step, data }: DialogSnapshot): Promise<void> {
      const json = data as Prisma.InputJsonObject;
      await db.dialogState.upsert({
        where: { userId },
        create: { userId, flow, step, data: json },
        update: { flow, step, data: json },
      });
    },

    async clear(userId: bigint): Promise<void> {
      await db.dialogState.deleteMany({ where: { userId } });
    },
  };
}
