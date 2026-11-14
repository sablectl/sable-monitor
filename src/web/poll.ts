export interface Poller {
  /** Run the task now and restart the countdown. */
  readonly refresh: () => void;
  /** Re-read the interval without running the task. */
  readonly reschedule: () => void;
  readonly stop: () => void;
}

/**
 * Runs a task, waits for it to finish, then schedules the next run. A
 * timeout chain rather than an interval, so a slow response never overlaps
 * the next request. An interval of zero means "once only".
 */
export function poll(
  task: () => Promise<void>,
  interval: () => number,
): Poller {
  let timer: number | undefined;
  let running = false;
  let stopped = false;

  const clear = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    clear();
    const ms = interval();
    if (stopped || running || ms <= 0) return;
    timer = window.setTimeout(() => {
      void run();
    }, ms);
  };

  async function run(): Promise<void> {
    if (stopped) return;
    clear();
    running = true;
    try {
      await task();
    } catch {
      // The task reports its own failures in the interface.
    }
    running = false;
    schedule();
  }

  void run();

  return {
    refresh: () => {
      if (!running) void run();
    },
    reschedule: schedule,
    stop: () => {
      stopped = true;
      clear();
    },
  };
}
