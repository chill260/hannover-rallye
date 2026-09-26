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


-- Branching quiz flow
alter table public.team_progress
  add column if not exists phase text not null default 'travel-main',
  add column if not exists branch_from_station integer,
  add column if not exists correct_answers integer not null default 0,
  add column if not exists detours integer not null default 0;

alter table public.team_progress
  drop constraint if exists team_progress_phase_check;

alter table public.team_progress
  add constraint team_progress_phase_check
  check (phase in ('travel-main','station-complete','question','travel-decoy','detour-reveal','finished'));

create table if not exists public.route_questions (
  from_station_index integer primary key,
  question text not null,
  options jsonb not null,
  correct_option integer not null check (correct_option >= 0),
  correct_target_index integer not null,
  decoy_name text not null,
  decoy_latitude double precision not null,
  decoy_longitude double precision not null,
  decoy_radius_m integer not null check (decoy_radius_m > 0),
  wrong_reveal text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.team_answers (
  team text not null check (team in ('A','B')),
  from_station_index integer not null references public.route_questions(from_station_index) on delete cascade,
  selected_option integer not null,
  answer_correct boolean not null,
  detour_completed boolean not null default false,
  answered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team, from_station_index)
);

insert into public.route_questions
(from_station_index, question, options, correct_option, correct_target_index, decoy_name, decoy_latitude, decoy_longitude, decoy_radius_m, wrong_reveal)
values
(0,'Welche beiden berühmten Lausbuben stammen von Wilhelm Busch?','["Max und Moritz","Hänsel und Gretel","Fritz und Franz"]'::jsonb,0,1,'Königinnendenkmal',52.382222,9.757222,50,'Nicht ganz. Richtig wäre „Max und Moritz“ gewesen. Euer eigentliches Ziel ist die Wilhelm-Busch-Wiese.'),
(1,'Wofür steht der Name „Wakitu“ ursprünglich?','["Wald-Kinder-Tummelplatz","Wald-Kultur-Treff","Wander-Kinder-Turnplatz"]'::jsonb,0,2,'Markuskirche',52.388292,9.752271,55,'Ehrenrunde beendet. Wakitu steht für „Wald-Kinder-Tummelplatz“. Euer eigentliches Ziel ist jetzt der Spielpark Wakitu.'),
(3,'Wie viele Zähne hat ein klassischer Leibniz Butterkeks?','["42","48","52"]'::jsonb,2,4,'Lister Platz',52.388756,9.750364,55,'Knusprig daneben: Ein klassischer Leibniz Butterkeks hat 52 Zähne. Euer eigentliches Ziel ist das Bahlsen-Stammhaus.'),
(4,'Was wurde 2013 spektakulär vom Bahlsen-Stammhaus gestohlen?','["Ein goldener Leibniz-Keks","Das historische Firmenlogo","Eine bronzene Werbefigur"]'::jsonb,0,5,'Weißekreuzplatz',52.381610,9.745350,60,'Falsche Fährte: Gestohlen wurde der goldene Leibniz-Keks. Euer eigentliches Ziel ist jetzt Vietal Kitchen.')
on conflict (from_station_index) do update set
  question = excluded.question,
  options = excluded.options,
  correct_option = excluded.correct_option,
  correct_target_index = excluded.correct_target_index,
  decoy_name = excluded.decoy_name,
  decoy_latitude = excluded.decoy_latitude,
  decoy_longitude = excluded.decoy_longitude,
  decoy_radius_m = excluded.decoy_radius_m,
  wrong_reveal = excluded.wrong_reveal;

alter table public.route_questions enable row level security;
alter table public.team_answers enable row level security;

drop policy if exists "authenticated can read route questions" on public.route_questions;
create policy "authenticated can read route questions"
on public.route_questions for select to authenticated using (true);

drop policy if exists "team can read own answers" on public.team_answers;
create policy "team can read own answers"
on public.team_answers for select to authenticated
using (team = private.rally_team() or private.rally_is_admin());

drop policy if exists "team can insert own answers" on public.team_answers;
create policy "team can insert own answers"
on public.team_answers for insert to authenticated
with check (team = private.rally_team() or private.rally_is_admin());

drop policy if exists "team can update own answers" on public.team_answers;
create policy "team can update own answers"
on public.team_answers for update to authenticated
using (team = private.rally_team() or private.rally_is_admin())
with check (team = private.rally_team() or private.rally_is_admin());

revoke all on public.route_questions from anon, authenticated;
revoke all on public.team_answers from anon, authenticated;
grant select on public.route_questions to authenticated;
grant select, insert, update on public.team_answers to authenticated;
