-- Hannover City Challenge - Supabase/PostgreSQL schema
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  team text check (team in ('A','B') or team is null),
  role text not null default 'player' check (role in ('player','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.team_progress (
  team text primary key check (team in ('A','B')),
  current_station integer not null default 0 check (current_station >= 0),
  hints integer not null default 0 check (hints >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  finished boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.station_progress (
  team text not null check (team in ('A','B')),
  station_index integer not null check (station_index >= 0),
  attempts integer not null default 0 check (attempts >= 0),
  hint_used boolean not null default false,
  completed boolean not null default false,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (team, station_index)
);

insert into public.team_progress(team)
values ('A'), ('B')
on conflict (team) do nothing;

create or replace function private.handle_rally_user()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  uname text;
begin
  uname := split_part(coalesce(new.email, ''), '@', 1);

  insert into public.profiles(id, username, team, role)
  values (
    new.id,
    uname,
    case when uname = 'team-a' then 'A' when uname = 'team-b' then 'B' else null end,
    case when uname = 'orga' then 'admin' else 'player' end
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_rally_user_created on auth.users;
create trigger on_rally_user_created
after insert on auth.users
for each row execute procedure private.handle_rally_user();

create or replace function private.rally_team()
returns text
language sql
stable
security definer
set search_path = public, private
as $$
  select team from public.profiles where id = auth.uid();
$$;

create or replace function private.rally_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, private
as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false);
$$;

revoke all on function private.handle_rally_user() from public, anon, authenticated;
revoke all on function private.rally_team() from public, anon;
revoke all on function private.rally_is_admin() from public, anon;
grant execute on function private.rally_team() to authenticated;
grant execute on function private.rally_is_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.team_progress enable row level security;
alter table public.station_progress enable row level security;

drop policy if exists "profile own or admin" on public.profiles;
create policy "profile own or admin"
on public.profiles for select to authenticated
using (id = auth.uid() or private.rally_is_admin());

drop policy if exists "all authenticated can see team scoreboard" on public.team_progress;
create policy "all authenticated can see team scoreboard"
on public.team_progress for select to authenticated
using (true);

drop policy if exists "team can update own progress" on public.team_progress;
create policy "team can update own progress"
on public.team_progress for update to authenticated
using (team = private.rally_team() or private.rally_is_admin())
with check (team = private.rally_team() or private.rally_is_admin());

drop policy if exists "team can see own stations" on public.station_progress;
create policy "team can see own stations"
on public.station_progress for select to authenticated
using (team = private.rally_team() or private.rally_is_admin());

drop policy if exists "team can insert own stations" on public.station_progress;
create policy "team can insert own stations"
on public.station_progress for insert to authenticated
with check (team = private.rally_team() or private.rally_is_admin());

drop policy if exists "team can update own stations" on public.station_progress;
create policy "team can update own stations"
on public.station_progress for update to authenticated
using (team = private.rally_team() or private.rally_is_admin())
with check (team = private.rally_team() or private.rally_is_admin());

revoke all on public.profiles from anon, authenticated;
revoke all on public.team_progress from anon, authenticated;
revoke all on public.station_progress from anon, authenticated;

grant select on public.profiles to authenticated;
grant select, update on public.team_progress to authenticated;
grant select, insert, update on public.station_progress to authenticated;
