import { describe, expect, it } from 'vitest';
import { buildDailySchedule, isQuietTime, type ScheduleSettings } from './schedule.js';

describe('isQuietTime', () => {
  const overnight = { start: '23:00', end: '07:00' };

  it.each([
    ['23:00', true],
    ['02:00', true],
    ['06:59', true],
    ['07:00', false],
    ['22:59', false],
    ['14:00', false],
  ])('23:00–07:00: %s → %s', (time, expected) => {
    expect(isQuietTime(time, overnight)).toBe(expected);
  });

  it.each([
    ['03:00', true],
    ['01:00', true],
    ['05:00', false],
    ['00:30', false],
  ])('01:00–05:00: %s → %s', (time, expected) => {
    expect(isQuietTime(time, { start: '01:00', end: '05:00' })).toBe(expected);
  });

  it('при совпадающих границах тихих часов нет', () => {
    expect(isQuietTime('03:00', { start: '07:00', end: '07:00' })).toBe(false);
  });
});

describe('buildDailySchedule', () => {
  const base: ScheduleSettings = {
    dailySendTime: '08:00',
    eveningReminderTime: '21:00',
    nightStart: '23:00',
    nightEnd: '07:00',
    nightPolicy: 'keep',
  };

  it('утренний слот после тихих часов — без ночных сообщений', () => {
    const schedule = buildDailySchedule(base);
    expect(schedule.newPortion).toEqual({ planned: '08:00', atNight: false, actual: '08:00' });
    expect(schedule.secondSlot).toEqual({ planned: '20:00', atNight: false, actual: '20:00' });
    expect(schedule.eveningReminder).toEqual({ planned: '21:00', atNight: false, actual: '21:00' });
    expect(schedule.hasNightEntries).toBe(false);
  });

  it('основной слот не считается ночным — это время выбрал сам пользователь', () => {
    const schedule = buildDailySchedule({ ...base, dailySendTime: '06:00', nightPolicy: 'move' });
    expect(schedule.newPortion).toEqual({ planned: '06:00', atNight: false, actual: '06:00' });
    expect(schedule.secondSlot).toEqual({ planned: '18:00', atNight: false, actual: '18:00' });
    expect(schedule.hasNightEntries).toBe(false);
  });

  it('keep: повтор через 12 часов остаётся ночью', () => {
    const schedule = buildDailySchedule({ ...base, dailySendTime: '14:00' });
    expect(schedule.secondSlot).toEqual({ planned: '02:00', atNight: true, actual: '02:00' });
    expect(schedule.hasNightEntries).toBe(true);
  });

  it('move: ночной повтор переносится на конец тихих часов', () => {
    const schedule = buildDailySchedule({ ...base, dailySendTime: '14:00', nightPolicy: 'move' });
    expect(schedule.secondSlot).toEqual({ planned: '02:00', atNight: true, actual: '07:00' });
    expect(schedule.newPortion.actual).toBe('14:00');
  });

  it('move: основной слот в тихие часы не переносится', () => {
    const schedule = buildDailySchedule({
      ...base,
      dailySendTime: '23:30',
      nightEnd: '08:00',
      nightPolicy: 'move',
    });
    expect(schedule.newPortion).toEqual({ planned: '23:30', atNight: false, actual: '23:30' });
    expect(schedule.secondSlot).toEqual({ planned: '11:30', atNight: false, actual: '11:30' });
    expect(schedule.hasNightEntries).toBe(false);
  });

  it('вечернее напоминание в тихие часы тоже учитывается', () => {
    const schedule = buildDailySchedule({ ...base, eveningReminderTime: '23:30' });
    expect(schedule.eveningReminder.atNight).toBe(true);
    expect(schedule.hasNightEntries).toBe(true);
  });
});
