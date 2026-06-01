/**
 * Next.js middleware — runs on every request before route handlers.
 *
 * Responsibilities (all cheap, all edge-runtime compatible):
 *   1. Origin / Referer allowlist on mutating requests (CSRF gate)
 *   2. Content-Type allowlist on mutating requests (rules out form-encoded CSRF)
 *   3. Per-IP token-bucket rate limit on hot endpoints (DoS + brute-force + LLM-spend gate)
 *
 * Notes:
 *   - The rate limit is in-memory per edge worker. It is intentionally
 *     conservative because workers can be plural across regions. Hitting the
 *     limit on one worker does not slow another. This is good-enough for
 *     testnet and a real moat against accidental floods. For mainnet, swap
 *     in Upstash or a Redis-backed limiter.
 *   - The cron endpoint is exempt — it has its own bearer-token auth.
 */

import { NextResponse, type NextRequest } from "next/server";

// ── Config ───────────────────────────────────────────────────────────

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Allowed Content-Types on mutations. Block form-encoded payloads so a
// cross-origin <form> submit can never trigger one of our routes.
const ALLOWED_CONTENT_TYPES = ["application/json"];

function buildAllowedOrigins(): string[] {
  const out = new Set<string>();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl) out.add(stripTrailingSlash(appUrl));
  // Always allow localhost on common dev ports
  out.add("http://localhost:3000");
  out.add("http://127.0.0.1:3000");
  return Array.from(out);
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// Per-endpoint rate limits (per IP, per rolling window).
// Tighter caps on endpoints that brute-force PINs or burn LLM credits.
type RateRule = { windowMs: number; max: number };
const RATE_RULES: Array<{ match: (path: string) => boolean; rule: RateRule }> = [
  { match: (p) => p === "/api/agent/interpret",  rule: { windowMs: 60_000, max: 20  } }, // LLM
  { match: (p) => p === "/api/agent/verify-pin", rule: { windowMs: 60_000, max: 10  } }, // PIN brute force
  { match: (p) => p === "/api/agent/set-limits", rule: { windowMs: 60_000, max: 10  } }, // PIN-gated
  { match: (p) => p === "/api/agent/withdraw",   rule: { windowMs: 60_000, max: 10  } }, // PIN-gated
  { match: (p) => p === "/api/agent/confirm-policy", rule: { windowMs: 60_000, max: 30 } },
  { match: (p) => p.startsWith("/api/"),         rule: { windowMs: 60_000, max: 120 } }, // catch-all
];

// ── In-memory rate-limit store ───────────────────────────────────────

type Bucket = { resetAt: number; count: number };
const buckets = new Map<string, Bucket>();

function hitRateLimit(key: string, rule: RateRule, now: number): { ok: boolean; resetAt: number; remaining: number } {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    const fresh = { resetAt: now + rule.windowMs, count: 1 };
    buckets.set(key, fresh);
    // Opportunistic cleanup so the map can't grow unbounded.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (v.resetAt <= now) buckets.delete(k);
      }
    }
    return { ok: true, resetAt: fresh.resetAt, remaining: rule.max - 1 };
  }
  b.count += 1;
  if (b.count > rule.max) {
    return { ok: false, resetAt: b.resetAt, remaining: 0 };
  }
  return { ok: true, resetAt: b.resetAt, remaining: rule.max - b.count };
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

// ── Middleware entry ─────────────────────────────────────────────────

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // Cron route runs its own bearer-token auth; skip CSRF and rate limit.
  if (pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  // Webhook receivers are server-to-server callbacks (Circle, etc.) — no
  // browser, no Origin/Referer, no session. They authenticate themselves
  // via signature verification inside the route handler. CSRF gating is
  // not the right protection model here, so let them through.
  if (pathname.startsWith("/api/webhooks/")) {
    return NextResponse.next();
  }

  const isApi = pathname.startsWith("/api/");

  // ── 1. CSRF gate on mutating API requests ─────────────────────────
  if (isApi && MUTATING_METHODS.has(req.method)) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    const allowed = buildAllowedOrigins();

    const isAllowedOrigin = (value: string | null): boolean => {
      if (!value) return false;
      try {
        const u = new URL(value);
        const base = `${u.protocol}//${u.host}`;
        return allowed.includes(stripTrailingSlash(base));
      } catch {
        return false;
      }
    };

    // Require Origin OR Referer to match an allowed origin. Browsers
    // always send Origin on cross-site mutations; same-site browser
    // requests also send Referer. Server-to-server requests with no
    // browser context are not the threat model here — they'd come with
    // no session cookie anyway.
    if (!isAllowedOrigin(origin) && !isAllowedOrigin(referer)) {
      return NextResponse.json(
        { error: "Cross-origin request rejected" },
        { status: 403 },
      );
    }

    // Content-Type allowlist — JSON only. Strips out the
    // form-submission CSRF vector.
    const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
    const acceptable = ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t));
    if (!acceptable) {
      return NextResponse.json(
        { error: "Unsupported Content-Type" },
        { status: 415 },
      );
    }
  }

  // ── 2. Rate limit on API surface ──────────────────────────────────
  if (isApi) {
    const ip = clientIp(req);
    const rule = RATE_RULES.find((r) => r.match(pathname))?.rule;
    if (rule) {
      const key = `${ip}:${pathname}`;
      const result = hitRateLimit(key, rule, Date.now());
      if (!result.ok) {
        return NextResponse.json(
          { error: "Too many requests. Slow down and try again." },
          {
            status: 429,
            headers: {
              "Retry-After": Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000)).toString(),
              "X-RateLimit-Limit": rule.max.toString(),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": Math.ceil(result.resetAt / 1000).toString(),
            },
          },
        );
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  // Run middleware on all API routes plus the auth callback (so origin
  // policy is enforced on POSTs into Supabase callbacks too, if any).
  matcher: ["/api/:path*"],
};
