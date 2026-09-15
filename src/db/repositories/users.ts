import type { Db } from '../client.js';

export interface TelegramUserInput {
  id: number;
  username?: string | undefined;
}

export function createUsersRepository(db: Db) {
  return {
    /** Создаёт пользователя при первом обращении, обновляет username и время активности. */
    async touch(input: TelegramUserInput, now: Date) {
      const id = BigInt(input.id);
      const username = input.username ?? null;
      return db.user.upsert({
        where: { id },
        create: { id, username, lastActivityAt: now },
        update: { username, lastActivityAt: now, blockedAt: null },
      });
    },
  };
}

export type UsersRepository = ReturnType<typeof createUsersRepository>;
