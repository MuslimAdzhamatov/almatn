// Последовательная очередь в памяти: тяжёлые разборы PDF идут по одному (CLAUDE.md, раздел 5.7).
// Устойчивость к перезапуску обеспечивает статус в БД: незавершённые разборы ставятся в очередь заново при старте.

export interface SerialQueue {
  /** Задачи в очереди, включая выполняющуюся. */
  readonly pending: number;
  push(task: () => Promise<void>): void;
  /** Промис, который выполнится, когда очередь опустеет. */
  idle(): Promise<void>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    get pending() {
      return pending;
    },
    push(task) {
      pending++;
      tail = tail
        .then(task)
        .catch(() => undefined)
        .finally(() => {
          pending--;
        });
    },
    idle() {
      return tail;
    },
  };
}
