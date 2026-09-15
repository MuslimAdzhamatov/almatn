import { describe, expect, it } from 'vitest';
import { pageChunks } from './chunks.js';

describe('pageChunks', () => {
  it('делит диапазон на части, последняя может быть короче', () => {
    expect(pageChunks(1, 120, 50)).toEqual([
      [1, 50],
      [51, 100],
      [101, 120],
    ]);
    expect(pageChunks(8, 28, 50)).toEqual([[8, 28]]);
    expect(pageChunks(3, 3, 50)).toEqual([[3, 3]]);
    expect(pageChunks(1, 100, 50)).toEqual([
      [1, 50],
      [51, 100],
    ]);
  });

  it('пустой диапазон и неверный размер', () => {
    expect(pageChunks(5, 4, 50)).toEqual([]);
    expect(() => pageChunks(1, 10, 0)).toThrow();
  });
});
