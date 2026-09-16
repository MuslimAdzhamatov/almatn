import { InlineKeyboard } from 'grammy';
import { texts } from '../texts.js';
import type { RenderedMessage } from './onboarding.js';

const t = texts.pause;

export const RESUME_CALLBACK = 'pause:resume';

export function autoPauseMessage(): RenderedMessage {
  return {
    text: t.autoPaused,
    keyboard: new InlineKeyboard().text(t.buttons.resume, RESUME_CALLBACK),
  };
}
