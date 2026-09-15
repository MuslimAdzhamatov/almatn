// Интерфейсы, которые сценарии app/ ожидают от внешних слоёв (БД, Telegram).
// Реализации — в db/repositories и delivery/bot; в тестах — простые подделки в памяти.

import type { NightPolicy } from '../core/time/schedule.js';

export interface UserSettings {
  timezone: string | null;
  dailySendTime: string | null;
  nightStart: string;
  nightEnd: string;
  nightPolicy: NightPolicy;
  eveningReminderTime: string;
  onboardedAt: Date | null;
}

export type UserSettingsPatch = Partial<Omit<UserSettings, 'onboardedAt'>> & { onboardedAt?: Date };

export interface UserSettingsStore {
  getSettings(userId: bigint): Promise<UserSettings | null>;
  updateSettings(userId: bigint, patch: UserSettingsPatch): Promise<void>;
}

/** Состояние многошагового диалога — переживает перезапуск бота. */
export interface DialogSnapshot {
  flow: string;
  step: string;
  data: Record<string, unknown>;
}

export interface DialogStore {
  get(userId: bigint): Promise<DialogSnapshot | null>;
  set(userId: bigint, dialog: DialogSnapshot): Promise<void>;
  clear(userId: bigint): Promise<void>;
}
