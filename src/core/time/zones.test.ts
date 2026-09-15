import { describe, expect, it } from 'vitest';
import {
  describeZone,
  findZoneOption,
  formatOffset,
  isZoneGroup,
  listZones,
  ZONE_OPTIONS,
} from './zones.js';

const SUMMER = new Date('2026-09-16T20:14:00Z');
const WINTER = new Date('2027-01-15T12:00:00Z');

describe('каталог поясов', () => {
  it('все пояса — корректные IANA-идентификаторы без повторов', () => {
    for (const option of ZONE_OPTIONS) {
      expect(() => describeZone(option.iana, SUMMER)).not.toThrow();
    }
    expect(new Set(ZONE_OPTIONS.map((o) => o.iana)).size).toBe(ZONE_OPTIONS.length);
  });

  it('Россия — от Калининграда (+2) до Камчатки (+12)', () => {
    const zones = listZones('russia', SUMMER);
    expect(zones[0]).toMatchObject({ city: 'Калининград', offsetMinutes: 120 });
    expect(zones.at(-1)).toMatchObject({ city: 'Камчатка', offsetMinutes: 720 });
    expect(zones.find((z) => z.city === 'Москва')?.offsetMinutes).toBe(180);
    expect(zones.find((z) => z.city === 'Екатеринбург')?.offsetMinutes).toBe(300);
  });

  it('группа UTC покрывает смещения −12…+14 с правильным знаком', () => {
    const offsets = listZones('utc', SUMMER).map((z) => z.offsetMinutes / 60);
    expect(offsets).toEqual(Array.from({ length: 27 }, (_, i) => i - 12));
    expect(describeZone('Etc/GMT-3', SUMMER).offsetMinutes).toBe(180);
  });

  it('пояса сортируются по смещению на текущую дату', () => {
    const offsets = listZones('world', SUMMER).map((z) => z.offsetMinutes);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('учитывает переход на летнее время', () => {
    expect(describeZone('Europe/Berlin', SUMMER).offsetMinutes).toBe(120);
    expect(describeZone('Europe/Berlin', WINTER).offsetMinutes).toBe(60);
    expect(describeZone('Europe/Moscow', WINTER).offsetMinutes).toBe(180);
  });

  it('показывает местное время в поясе', () => {
    expect(describeZone('Asia/Yekaterinburg', SUMMER).local.toFormat('HH:mm')).toBe('01:14');
  });

  it('находит пояс по IANA и отклоняет неизвестный', () => {
    expect(findZoneOption('Asia/Tehran')).toMatchObject({ city: 'Тегеран', group: 'world' });
    expect(findZoneOption('Mars/Olympus')).toBeUndefined();
    expect(() => describeZone('Mars/Olympus', SUMMER)).toThrow('Неизвестный часовой пояс');
  });

  it('проверяет название группы', () => {
    expect(isZoneGroup('russia')).toBe(true);
    expect(isZoneGroup('moon')).toBe(false);
  });
});

describe('formatOffset', () => {
  it.each([
    [180, '+3'],
    [330, '+5:30'],
    [345, '+5:45'],
    [-300, '−5'],
    [0, '+0'],
  ])('%i мин → %s', (minutes, expected) => {
    expect(formatOffset(minutes)).toBe(expected);
  });
});
