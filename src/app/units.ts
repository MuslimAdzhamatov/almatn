import { mergeRanges, rangesSpan, type MergedRange, type UnitRange } from '../core/srs/ranges.js';
import type { DeliveryRecord, LearningStore, PortionRecord, UnitBox } from './ports.js';

// Единицы, которые показывает сообщение: диапазоны с учётом пропущенных единиц и их координаты.

type UnitsStore = Pick<LearningStore, 'unitRows' | 'unitBoxes'>;

/** Объединённые диапазоны без пропущенных единиц по краям (CLAUDE.md, раздел 5.1). */
export async function mergedRanges(
  store: Pick<LearningStore, 'unitRows'>,
  textId: number,
  ranges: readonly UnitRange[],
): Promise<MergedRange[]> {
  const span = rangesSpan(ranges);
  if (!span) return [];
  return mergeRanges(await store.unitRows(textId, span.lineStart, span.lineEnd), ranges);
}

/** Непропущенные единицы диапазонов по порядку. */
export async function boxesIn(
  store: UnitsStore,
  textId: number,
  ranges: readonly UnitRange[],
): Promise<UnitBox[]> {
  const boxes: UnitBox[] = [];
  for (const range of ranges) {
    const rows = await store.unitBoxes(textId, range.lineStart, range.lineEnd);
    boxes.push(...rows.filter((box) => !box.skipped));
  }
  return boxes;
}

export interface DeliveryUnits {
  /** Объединённые диапазоны повторов отправки. */
  reviews: MergedRange[];
  /** Порция, которую нужно выучить (для сводки — невыученная порция из долга). */
  portion: PortionRecord | null;
  /** Всё, что показывает сообщение, одним списком диапазонов. */
  all: MergedRange[];
}

/** Что показывает отправка: порция или сводка (повторы, привязанные к ней, и порция из долга). */
export async function deliveryUnits(
  store: UnitsStore & Pick<LearningStore, 'deliveryReviews' | 'getPortion'>,
  textId: number,
  delivery: Pick<DeliveryRecord, 'id' | 'kind' | 'portionId'>,
): Promise<DeliveryUnits> {
  const portion = delivery.portionId === null ? null : await store.getPortion(delivery.portionId);
  const reviewRanges =
    delivery.kind === 'review_batch' || delivery.kind === 'debt_reminder'
      ? await store.deliveryReviews(delivery.id)
      : [];
  const own = portion ? [portion] : [];
  return {
    reviews: await mergedRanges(store, textId, reviewRanges),
    portion,
    all: await mergedRanges(store, textId, [...reviewRanges, ...own]),
  };
}
