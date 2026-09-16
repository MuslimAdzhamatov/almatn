import type { UserSettings, UserSettingsPatch, UserSettingsStore } from '../../app/ports.js';
import type { Db } from '../client.js';

export interface TelegramUserInput {
  id: number;
  username?: string | undefined;
}

export function createUsersRepository(db: Db) {
  const settings: UserSettingsStore = {
    async getSettings(userId: bigint): Promise<UserSettings | null> {
      return db.user.findUnique({
        where: { id: userId },
        select: {
          timezone: true,
          dailySendTime: true,
          nightStart: true,
          nightEnd: true,
          nightPolicy: true,
          eveningReminderTime: true,
          learnReminderDelayMin: true,
          onboardedAt: true,
        },
      });
    },

    async updateSettings(userId: bigint, patch: UserSettingsPatch): Promise<void> {
      await db.user.update({ where: { id: userId }, data: patch });
    },
  };

  return {
    ...settings,

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
