import type { Context } from 'grammy';

export interface BotUser {
  id: bigint;
  onboarded: boolean;
}

/** Контекст grammY с пользователем из БД — заполняется первым middleware. */
export type BotContext = Context & { user: BotUser };
