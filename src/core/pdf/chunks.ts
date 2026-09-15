// Диапазон страниц → части для рендера: большие документы рендерятся по частям,
// чтобы один вызов pdftoppm не упирался в таймаут и временные файлы не копились на диске.

export function pageChunks(first: number, last: number, size: number): [number, number][] {
  if (size < 1) throw new Error('Размер части должен быть не меньше 1');
  const chunks: [number, number][] = [];
  for (let from = first; from <= last; from += size) {
    chunks.push([from, Math.min(last, from + size - 1)]);
  }
  return chunks;
}
