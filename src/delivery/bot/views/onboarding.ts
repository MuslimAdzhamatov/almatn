import type { InlineKeyboard } from 'grammy';
import type { OnboardingScreen } from '../../../app/onboarding.js';
import {
  confirmTimezoneKeyboard,
  nightPolicyKeyboard,
  sendTimeKeyboard,
  timezoneKeyboard,
} from '../keyboards.js';
import { texts } from '../texts.js';

export interface RenderedMessage {
  text: string;
  keyboard?: InlineKeyboard;
}

export function renderOnboarding(screen: OnboardingScreen, firstName?: string): RenderedMessage {
  const t = texts.onboarding;
  switch (screen.kind) {
    case 'choose_timezone':
      return {
        text: screen.welcome
          ? `${t.welcome(firstName)}\n\n${t.chooseTimezone(screen.group)}`
          : t.chooseTimezone(screen.group),
        keyboard: timezoneKeyboard(screen.group, screen.zones),
      };
    case 'confirm_timezone':
      return { text: t.confirmTimezone(screen.zone), keyboard: confirmTimezoneKeyboard() };
    case 'choose_send_time':
      return {
        text: t.chooseSendTime(screen.zone, screen.error === 'invalid_time'),
        keyboard: sendTimeKeyboard(),
      };
    case 'choose_night_policy':
      return {
        text: t.chooseNightPolicy(screen.schedule, screen.nightStart, screen.nightEnd),
        keyboard: nightPolicyKeyboard(screen.nightEnd),
      };
    case 'choose_night_end':
      return { text: t.chooseNightEnd(screen.nightStart, screen.error) };
    case 'done':
      return { text: t.done(screen.zone, screen.schedule) };
    case 'summary':
      return { text: t.summary(screen.zone, screen.schedule) };
  }
}
