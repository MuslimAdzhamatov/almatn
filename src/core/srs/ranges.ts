// Слияние диапазонов повторов в одно сообщение (CLAUDE.md, раздел 5.1):
// 1–5 + 6–10 → 1–10, 1–5 + 16–20 → «1–5, 16–20». Пропущенные единицы не разрывают диапазон
// и не показываются, поэтому края диапазона — всегда непропущенные единицы.

export interface UnitRange {
  lineStart: number;
  lineEnd: number;
}

export interface MergedRange extends UnitRange {
  /** Сколько непропущенных единиц в диапазоне. */
  count: number;
}

export interface RangeUnit {
  lineNumber: number;
  skipped: boolean;
}

/**
 * Объединяет диапазоны: units — единицы текста, покрывающие все диапазоны (в любом порядке).
 * Два диапазона сливаются, если между ними нет ни одной непропущенной единицы вне диапазонов.
 */
export function mergeRanges(
  units: readonly RangeUnit[],
  ranges: readonly UnitRange[],
): MergedRange[] {
  const sorted = [...ranges].sort((a, b) => a.lineStart - b.lineStart);
  const covered = (n: number) => sorted.some((r) => r.lineStart <= n && n <= r.lineEnd);
  const result: MergedRange[] = [];
  let current: MergedRange | null = null;
  for (const unit of [...units].sort((a, b) => a.lineNumber - b.lineNumber)) {
    if (unit.skipped) continue;
    if (!covered(unit.lineNumber)) {
      current = null;
      continue;
    }
    if (current) {
      current.lineEnd = unit.lineNumber;
      current.count += 1;
    } else {
      current = { lineStart: unit.lineNumber, lineEnd: unit.lineNumber, count: 1 };
      result.push(current);
    }
  }
  return result;
}

/** Все единицы, которые нужно запросить для mergeRanges: от первой до последней границы. */
export function rangesSpan(ranges: readonly UnitRange[]): UnitRange | null {
  if (ranges.length === 0) return null;
  return {
    lineStart: Math.min(...ranges.map((r) => r.lineStart)),
    lineEnd: Math.max(...ranges.map((r) => r.lineEnd)),
  };
}
