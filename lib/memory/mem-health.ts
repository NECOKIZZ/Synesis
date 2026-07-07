/**
 * lib/memory/mem-health.ts — process-local memory-write health counters.
 *
 * WHY THIS EXISTS (root cause D4)
 *   Every memory write is fire-and-forget with `.catch(console.warn)`. That's
 *   the right UX call (a failed memory write must never break a user's
 *   transaction) — but it meant a HARD, SYSTEM-WIDE failure was invisible.
 *   F-4 was exactly this: the em-dash ByteString crash killed TWO memory
 *   layers for every user, and the only trace was a console.warn nobody was
 *   watching. From the outside it looked identical to "this user has no
 *   memory yet."
 *
 *   This module gives those swallowed failures a heartbeat: each catch bumps
 *   a per-store counter here, and the interpret DIAGNOSTICS block surfaces
 *   ok/fail tallies. A layer silently dying now shows up as a climbing fail
 *   count at a glance, without changing the never-throw contract.
 *
 * SCOPE
 *   Process-local, in-memory, best-effort — NOT durable metrics. It resets on
 *   deploy/restart and is per-server-instance. That's fine: its job is
 *   demo/triage visibility ("is memory writing at all right now?"), not
 *   long-term observability. Cheap, synchronous, never throws.
 */

export type MemStore = "profile" | "memwal" | "contact";

type Counter = { ok: number; fail: number; lastError?: string; lastErrorAt?: number };

const counters: Record<MemStore, Counter> = {
  profile: { ok: 0, fail: 0 },
  memwal: { ok: 0, fail: 0 },
  contact: { ok: 0, fail: 0 },
};

/** Record a successful write to a memory store. */
export function recordMemOk(store: MemStore): void {
  counters[store].ok += 1;
}

/**
 * Record a failed write. Pass the caught error so the last failure message
 * is retained for the diagnostics block (helps tell "flaky" from "dead").
 * `at` is an optional caller-supplied timestamp (ms) — callers on the hot
 * path can omit it; it's only used for display.
 */
export function recordMemFail(store: MemStore, err?: unknown, at?: number): void {
  const c = counters[store];
  c.fail += 1;
  c.lastError = err instanceof Error ? err.message : err != null ? String(err) : undefined;
  if (typeof at === "number") c.lastErrorAt = at;
}

/** Snapshot for the diagnostics formatter. Returns a shallow copy. */
export function memHealthSnapshot(): Record<MemStore, Counter> {
  return {
    profile: { ...counters.profile },
    memwal: { ...counters.memwal },
    contact: { ...counters.contact },
  };
}

/** Testing hook — zero all counters. */
export function _resetMemHealth(): void {
  for (const k of Object.keys(counters) as MemStore[]) {
    counters[k] = { ok: 0, fail: 0 };
  }
}
