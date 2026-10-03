/** Refused because every password-check slot is busy and the wait queue is full. */
export class PasswordCheckOverloadedError extends Error {
  constructor() {
    super('too many password checks in progress');
    this.name = 'PasswordCheckOverloadedError';
  }
}

/** Longest queue of waiting password checks. Beyond it a request is refused at once rather than holding a connection open. */
export const PASSWORD_CHECK_QUEUE_LIMIT = 10;

/** Bounds how many password hashes one process computes at once. */
export interface PasswordCheckGate {
  /** Runs `fn` once a slot is free, or throws {@link PasswordCheckOverloadedError} when the queue is full. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Hashes running now. */
  inFlight(): number;
}

/**
 * Builds the gate. Password hashing (scrypt) is deliberately slow and memory-hungry, so a flood of sign-in attempts spread across many addresses can pass every per-address limit and still exhaust the process. This caps concurrent hashes per process. It is a local semaphore with no cross-process owner, not a distributed lock.
 *
 * @param capacity - Reads the current maximum concurrent hashes, so a settings change applies without a restart.
 * @param onChange - Called with the in-flight count whenever it changes, for the gauge.
 * @returns The gate.
 */
export const createPasswordCheckGate = (
  capacity: () => Promise<number>,
  onChange: (inFlight: number) => void = () => {},
): PasswordCheckGate => {
  let running = 0;
  const waiting: Array<() => void> = [];
  // A finished check hands its slot straight to the oldest waiter instead of freeing it, so a caller arriving at that moment cannot take the slot as well and push concurrency past the cap.
  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
      return;
    }
    running -= 1;
    onChange(running);
  };
  return {
    async run(fn) {
      const max = await capacity();
      if (running >= max) {
        if (waiting.length >= PASSWORD_CHECK_QUEUE_LIMIT) throw new PasswordCheckOverloadedError();
        await new Promise<void>((resolve) => waiting.push(resolve));
      } else {
        running += 1;
        onChange(running);
      }
      try {
        return await fn();
      } finally {
        release();
      }
    },
    inFlight: () => running,
  };
};
