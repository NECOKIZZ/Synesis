/**
 * lib/agent-lock.ts
 *
 * Per-user in-memory mutex for serializing fund-affecting agent calls
 * within a single Node.js process. Closes the spend-limit race window
 * inside one serverless instance:
 *
 *   T0 user clicks Confirm twice within ~100ms (or two devices submit
 *      different sends at once).
 *   T1 Both requests reach the same warm instance.
 *   T2 Without a lock, both pass the limit check before either inserts
 *      its PENDING row, so daily caps can be overshot.
 *
 * The lock also fronts the `agent_idempotency` insert, so we avoid
 * pointless DB contention from the same intent racing itself.
 *
 * Limitations (acceptable on testnet, document for mainnet):
 *  - Does NOT serialize across separate serverless instances. Two
 *    concurrent requests landing in different cold containers will
 *    each acquire their own local lock. For full correctness across
 *    horizontal scale, move to a Postgres advisory lock or Redis.
 *  - Locks are released on a hard timeout (`DEFAULT_TIMEOUT_MS`) so a
 *    crashed handler can never wedge a user permanently.
 */

import "server-only";

type Waiter = () => void;

const queues = new Map<string, Waiter[]>();
const holders = new Map<string, number>(); // userId -> timeout id (NodeJS.Timeout coerced to number)

const DEFAULT_TIMEOUT_MS = 30_000;

function release(key: string): void {
  const timeoutId = holders.get(key);
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId as unknown as NodeJS.Timeout);
    holders.delete(key);
  }
  const q = queues.get(key);
  if (q && q.length > 0) {
    const next = q.shift()!;
    if (q.length === 0) queues.delete(key);
    // Re-acquire on behalf of the next waiter before running it.
    holders.set(
      key,
      setTimeout(() => {
        // Safety net: if the next waiter forgets to release, free the lock.
        holders.delete(key);
        const stillQueued = queues.get(key);
        if (stillQueued && stillQueued.length > 0) {
          const w = stillQueued.shift()!;
          if (stillQueued.length === 0) queues.delete(key);
          w();
        }
      }, DEFAULT_TIMEOUT_MS) as unknown as number,
    );
    next();
  }
}

/**
 * Run `fn` while holding an exclusive lock keyed by `userId`. Concurrent
 * calls for the same `userId` are serialized in arrival order. Different
 * `userId`s never block each other.
 *
 * The lock is automatically released when `fn` resolves or rejects.
 */
export async function withUserLock<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `u:${userId}`;

  // If nobody holds the lock, take it synchronously.
  if (!holders.has(key)) {
    holders.set(
      key,
      setTimeout(() => {
        holders.delete(key);
      }, DEFAULT_TIMEOUT_MS) as unknown as number,
    );
  } else {
    // Otherwise wait our turn.
    await new Promise<void>((resolve) => {
      const q = queues.get(key) ?? [];
      q.push(resolve);
      queues.set(key, q);
    });
  }

  try {
    return await fn();
  } finally {
    release(key);
  }
}
