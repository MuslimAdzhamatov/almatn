// Тик планировщика (CLAUDE.md, раздел 5.6): раз в минуту под advisory lock выполняются шаги —
// сводные повторы и напоминания о долге, затем новые порции и напоминания про неотмеченные порции.

export interface TickDeps {
  /** Выполняет fn под блокировкой; null — тик уже идёт в другом месте. */
  withLock<T>(fn: () => Promise<T>): Promise<T | null>;
  steps: readonly { name: string; run: (now: Date) => Promise<void> }[];
  reportError?: (err: unknown, context: Record<string, unknown>) => void;
}

export function createTick({ withLock, steps, reportError = () => undefined }: TickDeps) {
  /** true — тик выполнен, false — пропущен (блокировку держит другой тик). */
  return async function tick(now: Date): Promise<boolean> {
    const ran = await withLock(async () => {
      for (const step of steps) {
        try {
          await step.run(now);
        } catch (err) {
          reportError(err, { step: step.name });
        }
      }
      return true;
    });
    return ran !== null;
  };
}

export type Tick = ReturnType<typeof createTick>;
