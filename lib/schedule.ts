/**
 * lib/schedule.ts — single source of truth for the agent's time-based
 * schedule vocabulary and next-run math.
 *
 * Before this module existed, `computeNextRunTime` was copy-pasted (and had
 * already drifted) between `lib/skills/create-policy.ts` and
 * `app/api/cron/agent-policies/route.ts`, and EVERY fire time was hard-coded
 * to 09:00 UTC. This module replaces both copies and adds:
 *
 *   - a `time_of_day` ("HH:MM") so a schedule can fire at ANY time, not just 9am
 *   - `once`      — fire a single time at a specific datetime (`at`)
 *   - `hourly`    — every hour, at minute `:mm`
 *   - `interval`  — every N minutes (`every_minutes`)
 *   - optional `tz` (IANA name) — wall-clock times are interpreted in that
 *     zone; when omitted they are UTC (the product default).
 *
 * All returned instants are ISO strings in UTC. Time math is stored inside
 * `agent_policies.trigger_params` (JSONB, HMAC-signed), so no DB migration
 * is required.
 */

export const VALID_SCHEDULES = new Set([
  "once",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "interval",
]);

export type Schedule =
  | "once"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "interval";

/** Default fire time when a schedule omits `time_of_day` — preserves the
 * historical 09:00 UTC behavior for legacy rows. */
export const DEFAULT_TIME_OF_DAY = { h: 9, m: 0 } as const;

/**
 * Parse a "HH:MM" 24h string into {h, m}. Falls back to the historical
 * 09:00 default when the value is missing or malformed, so existing
 * daily/weekly/monthly policies (which never stored a time_of_day) keep
 * firing at 09:00 UTC.
 */
export function parseTimeOfDay(s?: string | null): { h: number; m: number } {
  if (typeof s !== "string") return { ...DEFAULT_TIME_OF_DAY };
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!match) return { ...DEFAULT_TIME_OF_DAY };
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    return { ...DEFAULT_TIME_OF_DAY };
  }
  return { h, m };
}

/** True if `s` is a valid "HH:MM" 24h string. */
export function isValidTimeOfDay(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!match) return false;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// ── Timezone helpers ─────────────────────────────────────────────────────

/**
 * The offset (in ms) of `tz` from UTC at the given instant: (local - UTC).
 * Uses Intl only — no external deps. Returns 0 (i.e. UTC) if `tz` is falsy
 * or invalid.
 */
function tzOffsetMs(date: Date, tz?: string): number {
  if (!tz) return 0;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const hour = map.hour === "24" ? 0 : Number(map.hour);
    const wallAsUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      hour,
      Number(map.minute),
      Number(map.second),
    );
    return wallAsUtc - date.getTime();
  } catch {
    // Invalid tz identifier — degrade to UTC rather than throw.
    return 0;
  }
}

/**
 * Convert a wall-clock time expressed in `tz` (or UTC when `tz` is omitted)
 * to the corresponding UTC instant. `month` is 0-indexed (JS convention).
 * Refines once to stay correct across DST boundaries.
 */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz?: string,
): Date {
  const wallAsUtc = Date.UTC(year, month, day, hour, minute, 0, 0);
  if (!tz) return new Date(wallAsUtc);
  const offset1 = tzOffsetMs(new Date(wallAsUtc), tz);
  let ts = wallAsUtc - offset1;
  const offset2 = tzOffsetMs(new Date(ts), tz);
  if (offset2 !== offset1) ts = wallAsUtc - offset2;
  return new Date(ts);
}

/**
 * The tz-local calendar parts of `date`. Weekday is 0=Sun..6=Sat. When `tz`
 * is omitted the values are UTC.
 */
function zonedParts(
  date: Date,
  tz?: string,
): { year: number; month: number; day: number; weekday: number } {
  if (!tz) {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      weekday: date.getUTCDay(),
    };
  }
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = dtf.formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) map[p.type] = p.value;
    const weekdayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return {
      year: Number(map.year),
      month: Number(map.month) - 1,
      day: Number(map.day),
      weekday: weekdayMap[map.weekday] ?? new Date(date).getUTCDay(),
    };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      weekday: date.getUTCDay(),
    };
  }
}

/** Last calendar day-of-month for a given year/month (month 0-indexed). */
function lastDomOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

// ── Next-run computation ─────────────────────────────────────────────────

export type ComputeNextRunOpts = {
  schedule: string;
  /** ISO datetime for `once`. Bare (no Z/offset) → interpreted in `tz`. */
  at?: string;
  /** "HH:MM" for hourly (minute only) / daily / weekly / monthly. */
  time_of_day?: string;
  /** 0=Sun..6=Sat, for weekly. */
  day_of_week?: number;
  /** 1-31, for monthly. */
  day_of_month?: number;
  /** for monthly end-of-month. */
  last_day_of_month?: boolean;
  /** for interval. */
  every_minutes?: number;
  /** IANA tz; omitted → UTC. */
  tz?: string;
  /** reference "now"; defaults to the current instant. */
  from?: Date;
};

/**
 * Compute the next UTC fire time for a time-based schedule. Returns an ISO
 * string, or `null` when the schedule can't produce a future instant
 * (unrecognised schedule, missing required field, or a `once` time that has
 * already passed).
 */
export function computeNextRun(opts: ComputeNextRunOpts): string | null {
  const from = opts.from ?? new Date();
  const tz = opts.tz;
  const { h, m } = parseTimeOfDay(opts.time_of_day);

  switch (opts.schedule) {
    case "once": {
      const at = parseAt(opts.at, tz);
      if (!at) return null;
      return at.getTime() > from.getTime() ? at.toISOString() : null;
    }

    case "interval": {
      const mins = Number(opts.every_minutes);
      if (!Number.isFinite(mins) || mins <= 0) return null;
      return new Date(from.getTime() + mins * 60_000).toISOString();
    }

    case "hourly": {
      // Every hour at minute `m`. Computed in UTC — minute-of-hour is what
      // matters and it aligns across whole-hour zones.
      const next = new Date(from);
      next.setUTCSeconds(0, 0);
      next.setUTCMinutes(m);
      if (next.getTime() <= from.getTime()) {
        next.setUTCHours(next.getUTCHours() + 1);
      }
      return next.toISOString();
    }

    case "daily": {
      const { year, month, day } = zonedParts(from, tz);
      let candidate = zonedToUtc(year, month, day, h, m, tz);
      if (candidate.getTime() <= from.getTime()) {
        const nd = new Date(Date.UTC(year, month, day + 1));
        candidate = zonedToUtc(nd.getUTCFullYear(), nd.getUTCMonth(), nd.getUTCDate(), h, m, tz);
      }
      return candidate.toISOString();
    }

    case "weekly": {
      const targetDow = Number.isInteger(opts.day_of_week) ? (opts.day_of_week as number) : 1; // default Monday
      const { year, month, day, weekday } = zonedParts(from, tz);
      let daysUntil = (targetDow - weekday + 7) % 7;
      let candidate = zonedToUtc(year, month, day + daysUntil, h, m, tz);
      if (candidate.getTime() <= from.getTime()) {
        daysUntil += 7;
        candidate = zonedToUtc(year, month, day + daysUntil, h, m, tz);
      }
      return candidate.toISOString();
    }

    case "monthly": {
      const { year, month } = zonedParts(from, tz);
      const build = (y: number, mo: number): Date => {
        const dom = opts.last_day_of_month
          ? lastDomOf(y, mo)
          : Math.min(
              Number.isInteger(opts.day_of_month) ? (opts.day_of_month as number) : 1,
              lastDomOf(y, mo),
            );
        return zonedToUtc(y, mo, dom, h, m, tz);
      };
      let candidate = build(year, month);
      if (candidate.getTime() <= from.getTime()) {
        const ny = month === 11 ? year + 1 : year;
        const nm = month === 11 ? 0 : month + 1;
        candidate = build(ny, nm);
      }
      return candidate.toISOString();
    }

    default:
      return null;
  }
}

/**
 * Parse a `once` trigger's `at` value into a UTC Date. An `at` carrying an
 * explicit zone (trailing Z or ±HH:MM) is absolute; a bare wall-clock value
 * ("2026-07-12T15:00" / "2026-07-12 15:00") is interpreted in `tz` (or UTC).
 * Returns null when unparseable.
 */
export function parseAt(at?: string, tz?: string): Date | null {
  if (typeof at !== "string" || !at.trim()) return null;
  const raw = at.trim();
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw);
  if (hasZone) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  // Bare wall-clock: pull out Y-M-D H:M(:S) and interpret in tz.
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!match) {
    // Last resort: let Date try (treated as local-UTC on the server).
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, hh, mm] = match;
  const dt = zonedToUtc(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), tz);
  return isNaN(dt.getTime()) ? null : dt;
}
