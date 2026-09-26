-- =============================================================================
-- 0002_forms_guests.sql — the Forms tracker and Guests tables.
--
-- Same access model as events: signed-in (house-password) users can read and
-- write; anonymous visitors can do nothing. Paste into the Supabase SQL editor.
-- =============================================================================

-- ---- forms -----------------------------------------------------------------
create table if not exists public.forms (
  id         text primary key,
  title      text not null,
  category   text default 'standing',   -- 'standing' (always open) | 'deadline'
  committee  text,
  link       text,
  due        date,
  notes      text,
  status     text default 'open',       -- 'open' | 'done'
  updated_at timestamptz not null default now()
);

-- ---- guests ----------------------------------------------------------------
create table if not exists public.guests (
  id         text primary key,
  name       text not null,
  host       text,                      -- which housemember is hosting
  arrival    date,
  departure  date,
  notes      text,
  updated_at timestamptz not null default now()
);

-- ---- row-level security ----------------------------------------------------
alter table public.forms  enable row level security;
alter table public.guests enable row level security;

drop policy if exists forms_read   on public.forms;
drop policy if exists forms_write  on public.forms;
drop policy if exists forms_modify on public.forms;
drop policy if exists forms_delete on public.forms;
create policy forms_read   on public.forms for select to authenticated using (true);
create policy forms_write  on public.forms for insert to authenticated with check (true);
create policy forms_modify on public.forms for update to authenticated using (true) with check (true);
create policy forms_delete on public.forms for delete to authenticated using (true);

drop policy if exists guests_read   on public.guests;
drop policy if exists guests_write  on public.guests;
drop policy if exists guests_modify on public.guests;
drop policy if exists guests_delete on public.guests;
create policy guests_read   on public.guests for select to authenticated using (true);
create policy guests_write  on public.guests for insert to authenticated with check (true);
create policy guests_modify on public.guests for update to authenticated using (true) with check (true);
create policy guests_delete on public.guests for delete to authenticated using (true);

-- ---- realtime --------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='forms') then
    alter publication supabase_realtime add table public.forms;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='guests') then
    alter publication supabase_realtime add table public.guests;
  end if;
end $$;

-- ---- seed the standing + deadline forms ------------------------------------
insert into public.forms (id, title, category, committee, link, due, notes, status) values
  ('form-naghag',       'NAG HAG — House & Grounds request', 'standing', 'hag',       '', null, 'Ask House & Grounds for something you need.', 'open'),
  ('form-maintenance',  'Maintenance request',               'standing', 'hag',       '', null, 'Something in the House is broken or needs fixing.', 'open'),
  ('form-guest',        'Guest request',                     'standing', 'rgc',       '', null, 'Requesting to host a guest. Also log them under the Guests tab.', 'open'),
  ('form-headshots',    'Headshots & bios',                  'deadline', 'commscom',  '', null, 'For the website. Set a due date once CommsCom picks one.', 'open'),
  ('form-socialspitch', 'Socials pitch',                     'deadline', 'socialcom', '', null, 'Pitch a social you want the House to run.', 'open')
on conflict (id) do nothing;
