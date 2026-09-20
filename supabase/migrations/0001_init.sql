-- =============================================================================
-- 0001_init.sql — Telluride House calendar schema
--
-- One events table mirroring the app's event shape, with row-level security so
-- that only a signed-in user (i.e. someone who entered the shared house
-- password) can read or write. Everyone shares a single Supabase login; the
-- public, read-only projection is the separate token-gated .ics feed.
--
-- Apply by pasting into the Supabase SQL editor (or `supabase db push`).
-- =============================================================================

-- ---- events ----------------------------------------------------------------
-- Column names are kept identical to the JSON field names the app already uses
-- (camelCase columns are quoted so PostgREST accepts the same object verbatim).
create table if not exists public.events (
  id           text primary key,
  layer        text not null default 'event',   -- 'event' | 'academic'
  track        text,                             -- hm|cm|forum|pref|soc|kitchen|world|dl|bday
  title        text not null,
  date         date,                             -- null => "Needs a date" tray
  "endDate"    date,
  "start"      text,                             -- 'HH:MM'
  "end"        text,                             -- 'HH:MM'
  repeat       text default 'none',              -- none|weekly|biweekly|monthly|annual
  until        date,
  "skipBreaks" boolean default true,
  "where"      text,
  host         text,                             -- 'house' | 'external' | ''
  link         text,
  notes        text,
  committee    text,
  unconfirmed  boolean default false,
  "isBreak"    boolean default false,            -- academic entries only
  updated_at   timestamptz not null default now()
);

create index if not exists events_date_idx on public.events (date);
create index if not exists events_track_idx on public.events (track);

-- ---- row-level security ----------------------------------------------------
-- Signed-in (authenticated) users can do everything; anonymous visitors get
-- nothing. Signing in requires the shared house password, so the password is
-- the gate and RLS is what enforces it.
alter table public.events enable row level security;

drop policy if exists events_read   on public.events;
drop policy if exists events_write  on public.events;
drop policy if exists events_modify on public.events;
drop policy if exists events_delete on public.events;

create policy events_read   on public.events for select to authenticated using (true);
create policy events_write  on public.events for insert to authenticated with check (true);
create policy events_modify on public.events for update to authenticated using (true) with check (true);
create policy events_delete on public.events for delete to authenticated using (true);

-- ---- realtime --------------------------------------------------------------
-- Let the front end receive live inserts/updates/deletes.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
end $$;
