-- =====================================================================
-- DotArc — User Memory (Layer B: long-lived habits & preferences)
-- =====================================================================
-- Stores DERIVED and STATED facts about a user that make the agent feel
-- like it knows them across sessions:
--
--   kind = 'contact'           — someone the user sends to (subject = address)
--   kind = 'spending_pattern'  — recurring send behaviour (subject = address)
--   kind = 'token_pref'        — token the user tends to use (subject = symbol)
--   kind = 'preference'        — explicitly stated preference (subject = slug)
--   kind = 'note'              — freeform "remember this" (subject = null)
--
-- This is NOT conversation history (that's client-side, in-session) and
-- NOT the long-term semantic store (that's Walrus, added later and kept
-- behind its own adapter). This table is deterministic, structured, and
-- cheap to query — the agent injects the top rows into its system prompt.
--
-- `content` is a jsonb payload of structured fields. The human-readable
-- "fact" sentence is BUILT AT RECALL TIME from these fields + hit_count,
-- so counts always reflect reality without a rewrite on every event.
-- =====================================================================

create table if not exists public.user_memory (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  kind         text not null,
  subject      text,                       -- normalized upsert key (address / symbol / slug); null for free notes
  content      jsonb not null default '{}',
  hit_count    int  not null default 1,    -- how many times this fact was reinforced
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint user_memory_kind_check
    check (kind in ('contact','spending_pattern','token_pref','preference','note'))
);

-- One row per (user, kind, subject). Free notes (subject null) are never
-- deduped — each is its own row, so the partial unique index excludes them.
create unique index if not exists user_memory_user_kind_subject_uidx
  on public.user_memory(user_id, kind, subject)
  where subject is not null;

create index if not exists user_memory_user_rank_idx
  on public.user_memory(user_id, hit_count desc, last_seen_at desc);

-- ── RLS ───────────────────────────────────────────────────────────────
alter table public.user_memory enable row level security;

drop policy if exists "users read own memory" on public.user_memory;
create policy "users read own memory"
  on public.user_memory for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own memory" on public.user_memory;
create policy "users insert own memory"
  on public.user_memory for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update own memory" on public.user_memory;
create policy "users update own memory"
  on public.user_memory for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "users delete own memory" on public.user_memory;
create policy "users delete own memory"
  on public.user_memory for delete
  using (auth.uid() = user_id);

-- ── Upsert-with-increment helper ──────────────────────────────────────
-- Called from the server (service role) after meaningful events. Atomic
-- upsert that bumps hit_count + last_seen_at and merges the latest
-- structured content. security definer so it runs regardless of the
-- caller's RLS context; we still scope every write to the passed user_id.
create or replace function public.record_user_memory(
  p_user_id uuid,
  p_kind    text,
  p_subject text,
  p_content jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_subject is null then
    -- Free notes are append-only (no natural key to dedupe on).
    insert into public.user_memory (user_id, kind, subject, content)
    values (p_user_id, p_kind, null, coalesce(p_content, '{}'::jsonb));
  else
    insert into public.user_memory (user_id, kind, subject, content)
    values (p_user_id, p_kind, p_subject, coalesce(p_content, '{}'::jsonb))
    on conflict (user_id, kind, subject) where subject is not null
    do update set
      hit_count    = public.user_memory.hit_count + 1,
      last_seen_at = now(),
      content      = public.user_memory.content || excluded.content;
  end if;
end;
$$;

comment on table public.user_memory is
  'Layer B agent memory: structured, deterministic habits & preferences injected into the system prompt. Not conversation history (client-side) and not the Walrus semantic store (separate adapter).';
