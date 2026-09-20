-- =============================================================================
-- 0001_init.sql — Telluride House calendar schema
--
-- One events table mirroring the app's event shape, a small allowlist table,
-- row-level security so only allow-listed signed-in users can read or write,
-- and a helper the front end uses to pick which banner to show.
--
-- Apply with the Supabase CLI (`supabase db push`) or paste into the SQL editor.
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

-- ---- allowlist -------------------------------------------------------------
create table if not exists public.allowed_emails (
  email text primary key
);

-- is_member(): true when the caller's Google email is on the allowlist.
-- SECURITY DEFINER so it can read allowed_emails regardless of the caller's
-- own row-level access. Used by the app only to choose a banner; the policies
-- below are what actually enforce access.
create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_emails
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---- row-level security ----------------------------------------------------
alter table public.events        enable row level security;
alter table public.allowed_emails enable row level security;

-- Everyone on the allowlist (and signed in) can do everything; nobody else can.
drop policy if exists events_member_read   on public.events;
drop policy if exists events_member_write  on public.events;
drop policy if exists events_member_modify on public.events;
drop policy if exists events_member_delete on public.events;

create policy events_member_read   on public.events for select using (public.is_member());
create policy events_member_write  on public.events for insert with check (public.is_member());
create policy events_member_modify on public.events for update using (public.is_member()) with check (public.is_member());
create policy events_member_delete on public.events for delete using (public.is_member());

-- Members may read the allowlist; only the service role (which bypasses RLS)
-- may change it, i.e. via the seed script.
drop policy if exists allowed_emails_member_read on public.allowed_emails;
create policy allowed_emails_member_read on public.allowed_emails for select using (public.is_member());

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
