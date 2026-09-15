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

export function timezoneKeyboard(group: ZoneGroup, zones: ZoneNow[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  zones.forEach((zone, index) => {
    keyboard.text(texts.onboarding.zoneButton(zone), `${callbacks.zone}:${zone.iana}`);
    if (index % 2 === 1) keyboard.row();
  });
  if (zones.length % 2 === 1) keyboard.row();
  for (const other of ZONE_GROUPS.filter((g) => g !== group)) {
    keyboard.text(texts.onboarding.groups[other], `${callbacks.zoneGroup}:${other}`).row();
  }
  return keyboard;
}

export function confirmTimezoneKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(texts.onboarding.confirmYes, callbacks.zoneYes)
    .text(texts.onboarding.confirmNo, callbacks.zoneNo);
}

export function sendTimeKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of SEND_TIME_PRESETS) {
    for (const time of row) keyboard.text(time, `${callbacks.sendTime}:${time}`);
    keyboard.row();
  }
  return keyboard;
}

export function nightPolicyKeyboard(nightEnd: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(texts.onboarding.nightKeep, `${callbacks.night}:keep`)
    .row()
    .text(texts.onboarding.nightMove(nightEnd), `${callbacks.night}:move`)
    .row()
    .text(texts.onboarding.nightOther, `${callbacks.night}:other`);
}
