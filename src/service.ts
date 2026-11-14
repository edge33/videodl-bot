import { setTimeout as delay } from "node:timers/promises";

interface Services {
  worker: { drain(signal: AbortSignal): Promise<void> };
  notifications: { flush(): Promise<void> };
  shutdown: AbortController;
  poll(signal: AbortSignal, wake: () => void): Promise<void>;
}

export async function runService({
  worker,
  notifications,
  shutdown,
  poll,
}: Services): Promise<void> {
  const { signal } = shutdown;
  const failure = Promise.withResolvers<never>();
  let requested = false;
  let running: Promise<void> | undefined;
  const wake = () => {
    if (signal.aborted) return;
    requested = true;
    if (running) return;
    // Defer execution until running is assigned, including an empty startup queue.
    running = Promise.resolve().then(async () => {
      try {
        do {
          requested = false;
          await worker.drain(signal);
        } while (requested && !signal.aborted);
      } finally {
        // No await between the final request check and becoming idle.
        running = undefined;
      }
    });
    void running.catch(failure.reject);
  };
  const polling = Promise.resolve().then(() => poll(signal, wake));
  const background = Promise.resolve().then(async () => {
    while (!signal.aborted) {
      await notifications.flush();
      // Only status delivery uses a timer; abort interrupts the sleep.
      await delay(10000, undefined, { signal }).catch(() => {});
    }
  });
  // Startup wake recovers durable work even if an earlier process missed its event.
  wake();
  try {
    await Promise.race([polling, background, failure.promise]);
  } finally {
    shutdown.abort();
    await Promise.allSettled([polling, background, running]);
  }
}
