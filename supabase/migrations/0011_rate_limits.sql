-- =====================================================================
-- DotArc — Rate Limits (per-user fixed-window counters)
-- =====================================================================
-- Backs lib/rate-limit.ts. Protects the expensive / money-moving agent
-- routes from abuse:
--   - /api/agent/interpret      (calls OpenRouter — costs money)
--   - /api/agent/confirm-policy (moves USDC)
--
-- The increment happens INSIDE a single security-definer RPC so concurrent
-- serverless (Vercel) invocations can't race past the limit. Fixed-window
-- algorithm: each (action:user) key holds a window_start + count; once the
-- window elapses the next request resets it.
--
-- Only the service role touches this table (via consume_rate_limit). RLS is
-- enabled with NO policies so it is inaccessible to client/anon roles; the
-- security-definer function runs as owner and bypasses RLS.
-- =====================================================================

create table if not exists public.rate_limits (
  bucket_key   text primary key,           -- "<action>:<user_id>"
  window_start timestamptz not null default now(),
  count        int not null default 0
);

-- Helps an optional periodic cleanup of stale buckets (not required for
-- correctness — windows self-reset on next hit).
create index if not exists rate_limits_window_start_idx
  on public.rate_limits(window_start);

alter table public.rate_limits enable row level security;
-- Intentionally no policies: deny all direct access. Writes happen only
-- through consume_rate_limit() (security definer, service role).

-- ── Atomic consume ────────────────────────────────────────────────────
-- Returns whether the caller is under the limit for this window, plus how
-- many seconds until the window resets (0 when allowed). Counting continues
-- past the cap (harmless — int, and the window resets), so retry_after is
-- always measured from the current window_start.
create or replace function public.consume_rate_limit(
  p_key            text,
  p_max            int,
  p_window_seconds int
)
returns table(allowed boolean, retry_after_seconds int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now          timestamptz := now();
  v_window_start timestamptz;
  v_count        int;
  v_expired      boolean;
begin
  insert into public.rate_limits (bucket_key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (bucket_key) do update
    set
      count = case
        when public.rate_limits.window_start
             < v_now - make_interval(secs => p_window_seconds)
          then 1
        else public.rate_limits.count + 1
      end,
      window_start = case
        when public.rate_limits.window_start
             < v_now - make_interval(secs => p_window_seconds)
          then v_now
        else public.rate_limits.window_start
      end
  returning public.rate_limits.window_start, public.rate_limits.count
    into v_window_start, v_count;

  if v_count <= p_max then
    allowed := true;
    retry_after_seconds := 0;
  else
    allowed := false;
    retry_after_seconds := greatest(
      1,
      ceil(extract(epoch from (
        v_window_start + make_interval(secs => p_window_seconds) - v_now
      )))::int
    );
  end if;
  return next;
end;
$$;

comment on table public.rate_limits is
  'Per-user fixed-window rate-limit counters for abuse protection on agent routes. Written only via consume_rate_limit() (security definer).';
