import { InlineKeyboard } from 'grammy';
import { LEARN_DELAY_PRESETS, type SettingsScreen } from '../../../app/settings.js';
import { formatUserDate } from '../../../core/plan/dates.js';
import { nightPolicyKeyboard, sendTimeKeyboard, timezoneKeyboard } from '../keyboards.js';
import { scheduleText, texts, zoneTitle } from '../texts.js';
import type { RenderedMessage } from './onboarding.js';

// /settings (CLAUDE.md, раздел 5.5).

const t = texts.settings;
const b = t.buttons;

/** callback_data: `se:<действие>[:<значение>[:<значение>]]`. */
export const SETTINGS_CALLBACK = /^se:(\w+)(?::([^:]*))?(?::([^:]*))?$/;

export const cb = (action: string, ...args: (string | number)[]) =>
  ['se', action, ...args].join(':');

const back = () => new InlineKeyboard().text(b.back, cb('menu'));
const localTime = (zone: { local: { toFormat(f: string): string } }) =>
  zone.local.toFormat('HH:mm, dd.MM');
const daysText = (days: readonly number[]) =>
  days.length === 0 ? t.restNone : days.map((d) => texts.plan.weekdays[d - 1]).join(', ');
const daysArg = (days: readonly number[]) => (days.length === 0 ? '-' : days.join('.'));

export function settingsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(b.timezone, cb('tz'))
    .text(b.time, cb('time'))
    .row()
    .text(b.quiet, cb('quiet'))
    .text(b.evening, cb('eve'))
    .row()
    .text(b.delay, cb('delay'))
    .text(b.rest, cb('rest'))
    .row()
    .text(b.pace, 'mg:pace')
    .text(b.pause, 'mg:pause')
    .row()
    .text(b.deleteText, 'mg:del')
    .row()
    .text(b.deleteAll, 'mg:wipe');
}

export function renderSettings(
  screen: Exclude<SettingsScreen, { kind: 'stale' }>,
): RenderedMessage {
  switch (screen.kind) {
    case 'menu': {
      const { info } = screen;
      const lines = [
        ...(screen.saved ? [t.saved, ''] : []),
        t.title,
        '',
        t.zone(zoneTitle(info.zone), localTime(info.zone)),
        scheduleText(info.schedule),
        t.quiet(info.nightStart, info.nightEnd, info.nightPolicy === 'move'),
        t.learnDelay(t.hours(info.learnReminderDelayMin)),
        t.rest(info.restDays && daysText(info.restDays)),
      ];
      const shifted = screen.shifted.filter((s) => s.endDate !== null);
      if (shifted.length > 0) {
        lines.push(
          '',
          t.shiftedTitle,
          ...shifted.map((s) => t.shiftedItem(s.title, formatUserDate(s.endDate!))),
        );
      }
      return { text: lines.join('\n'), keyboard: settingsMenuKeyboard() };
    }
    case 'timezone':
      return {
        text: t.chooseTimezone,
        keyboard: timezoneKeyboard(screen.group, screen.zones, {
          zone: 'se:tzp',
          group: 'se:tz',
        })
          .row()
          .text(b.back, cb('menu')),
      };
    case 'timezone_confirm':
      return {
        text: t.confirmTimezone(zoneTitle(screen.zone), localTime(screen.zone)),
        keyboard: new InlineKeyboard()
          .text(b.save, cb('tzok', screen.zone.iana))
          .text(b.back, cb('tz')),
      };
    case 'send_time':
      return {
        text: t.sendTime(screen.current, screen.invalid),
        keyboard: sendTimeKeyboard('se:timeset').row().text(b.back, cb('menu')),
      };
    case 'night_policy':
      return {
        text: texts.onboarding.chooseNightPolicy(
          screen.schedule,
          screen.nightStart,
          screen.nightEnd,
        ),
        keyboard: nightPolicyKeyboard(screen.nightEnd, 'se:night'),
      };
    case 'night_end':
      return {
        text: texts.onboarding.chooseNightEnd(screen.nightStart, screen.error ?? undefined),
      };
    case 'quiet':
      return {
        text: t.quietMenu(screen.nightStart, screen.nightEnd, screen.nightPolicy === 'move'),
        keyboard: new InlineKeyboard()
          .text(`${screen.nightPolicy === 'keep' ? '✅ ' : ''}${b.quietKeep}`, cb('qpol', 'keep'))
          .row()
          .text(
            `${screen.nightPolicy === 'move' ? '✅ ' : ''}${b.quietMove(screen.nightEnd)}`,
            cb('qpol', 'move'),
          )
          .row()
          .text(b.quietHours, cb('qhours'))
          .row()
          .text(b.back, cb('menu')),
      };
    case 'quiet_hours':
      return { text: t.quietHours(screen.invalid), keyboard: back() };
    case 'evening': {
      const keyboard = new InlineKeyboard();
      for (const time of ['20:00', '21:00', '22:00']) keyboard.text(time, cb('eveset', time));
      return {
        text: t.evening(screen.current, screen.invalid),
        keyboard: keyboard.row().text(b.back, cb('menu')),
      };
    }
    case 'learn_delay': {
      const keyboard = new InlineKeyboard();
      for (const minutes of LEARN_DELAY_PRESETS) {
        const label = t.hours(minutes);
        keyboard.text(minutes === screen.current ? `✅ ${label}` : label, cb('delayset', minutes));
      }
      return {
        text: t.learnDelayMenu(t.hours(screen.current)),
        keyboard: keyboard.row().text(b.back, cb('menu')),
      };
    }
    case 'rest_days': {
      const keyboard = new InlineKeyboard();
      const current = daysArg(screen.restDays);
      texts.plan.weekdaysShort.forEach((label, index) => {
        const day = index + 1;
        const chosen = screen.restDays.includes(day);
        keyboard.text(chosen ? `✅ ${label}` : label, cb('rest', current, day));
        if (index === 3) keyboard.row();
      });
      return {
        text: `${t.restDays}\n\n${t.rest(daysText(screen.restDays))}`,
        keyboard: keyboard.row().text(b.save, cb('restok', current)).text(b.back, cb('menu')),
      };
    }
    case 'no_plans':
      return { text: t.noPlans, keyboard: back() };
  }
}
