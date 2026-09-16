import { InlineKeyboard } from 'grammy';
import { ZONE_GROUPS, type ZoneGroup, type ZoneNow } from '../../core/time/zones.js';
import { texts } from './texts.js';

// callback_data: короткий префикс + значение (лимит Telegram — 64 байта).
export const callbacks = {
  zoneGroup: 'tzg',
  zone: 'tz',
  zoneYes: 'tzok',
  zoneNo: 'tzno',
  sendTime: 'st',
  night: 'night',
} as const;

const SEND_TIME_PRESETS = [
  ['05:00', '06:00', '07:00', '08:00'],
  ['12:00', '14:00', '18:00', '20:00'],
];

/** prefix — начало callback_data для выбора пояса и группы (онбординг и /settings). */
export function timezoneKeyboard(
  group: ZoneGroup,
  zones: ZoneNow[],
  prefix: { zone: string; group: string } = { zone: callbacks.zone, group: callbacks.zoneGroup },
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  zones.forEach((zone, index) => {
    keyboard.text(texts.onboarding.zoneButton(zone), `${prefix.zone}:${zone.iana}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (zones.length % 2 === 1) keyboard.row();
  for (const other of ZONE_GROUPS.filter((g) => g !== group)) {
    keyboard.text(texts.onboarding.groups[other], `${prefix.group}:${other}`).row();
  }
  return keyboard;
}

export function confirmTimezoneKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(texts.onboarding.confirmYes, callbacks.zoneYes)
    .text(texts.onboarding.confirmNo, callbacks.zoneNo);
}

export function sendTimeKeyboard(prefix: string = callbacks.sendTime): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of SEND_TIME_PRESETS) {
    for (const time of row) keyboard.text(time, `${prefix}:${time}`);
    keyboard.row();
  }
  return keyboard;
}

export function nightPolicyKeyboard(
  nightEnd: string,
  prefix: string = callbacks.night,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(texts.onboarding.nightKeep, `${prefix}:keep`)
    .row()
    .text(texts.onboarding.nightMove(nightEnd), `${prefix}:move`)
    .row()
    .text(texts.onboarding.nightOther, `${prefix}:other`);
}
