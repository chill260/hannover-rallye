-- Hannover City Challenge - current schema (v2)
-- Public browser clients use only a publishable key plus RLS/RPC.
-- Player-facing secrets live in private.rally_question_secrets and are never directly selectable.

create schema if not exists private;
revoke all on schema private from public;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  team text check (team in ('A','B') or team is null),
  role text not null default 'player' check (role in ('player','admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.rally_routes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null check (status in ('draft','published','archived')),
  created_at timestamptz not null default now(),
  published_at timestamptz
);
create unique index if not exists rally_one_published_route on public.rally_routes ((status)) where status='published';
create unique index if not exists rally_one_draft_route on public.rally_routes ((status)) where status='draft';

create table if not exists public.rally_stations (
  route_id uuid not null references public.rally_routes(id) on delete cascade,
  station_id uuid not null default gen_random_uuid(),
  sort_order integer not null check (sort_order >= 0),
  name text not null,
  latitude double precision not null,
  longitude double precision not null,
  radius_m integer not null default 55 check (radius_m between 20 and 250),
  clue text not null default '',
  hint text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (route_id,station_id),
  unique(route_id,sort_order)
);

create table if not exists public.rally_questions (
  route_id uuid not null references public.rally_routes(id) on delete cascade,
  question_id uuid not null default gen_random_uuid(),
  from_station_id uuid,
  target_station_id uuid not null,
  question_type text not null default 'free_text' check (question_type in ('free_text','multiple_choice','team_challenge')),
  fun_fact text,
  question text not null,
  options jsonb,
  hint_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(route_id,question_id),
  foreign key(route_id,from_station_id) references public.rally_stations(route_id,station_id) on delete cascade,
  foreign key(route_id,target_station_id) references public.rally_stations(route_id,station_id) on delete cascade
);
create unique index if not exists rally_question_after_station_unique
  on public.rally_questions(route_id,coalesce(from_station_id,'00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists private.rally_question_secrets (
  route_id uuid not null,
  question_id uuid not null,
  accepted_answers jsonb not null default '[]'::jsonb,
  correct_option integer,
  solution_text text,
  primary key(route_id,question_id),
  foreign key(route_id,question_id) references public.rally_questions(route_id,question_id) on delete cascade
);

create table if not exists public.rally_team_runs (
  team text primary key check (team in ('A','B')),
  route_id uuid not null references public.rally_routes(id),
  phase text not null check (phase in ('question','travel','finished')),
  current_station_id uuid,
  current_question_id uuid,
  correct_answers integer not null default 0,
  penalty_points integer not null default 0,
  hints integer not null default 0,
  gps_attempts integer not null default 0,
  finished boolean not null default false,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.rally_team_station_progress (
  team text not null check (team in ('A','B')),
  route_id uuid not null,
  station_id uuid not null,
  attempts integer not null default 0,
  hint_used boolean not null default false,
  completed boolean not null default false,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(team,route_id,station_id),
  foreign key(route_id,station_id) references public.rally_stations(route_id,station_id) on delete cascade
);

create table if not exists public.rally_team_question_progress (
  team text not null check (team in ('A','B')),
  route_id uuid not null,
  question_id uuid not null,
  wrong_attempts integer not null default 0,
  solved boolean not null default false,
  penalty_points integer not null default 0,
  hint_shown boolean not null default false,
  last_selected_option integer,
  updated_at timestamptz not null default now(),
  primary key(team,route_id,question_id),
  foreign key(route_id,question_id) references public.rally_questions(route_id,question_id) on delete cascade
);

-- Security model:
-- 1. Admin reads/edits route content directly, but only draft rows are editable.
-- 2. Players do not directly select route/station/question tables.
-- 3. Players do not directly update run/progress tables.
-- 4. Player state, answer checking, hints and GPS checks are exposed only through authenticated RPCs.
-- 5. private.rally_question_secrets is not directly granted to browser roles.
--
-- RPCs used by game.js:
--   get_rally_player_state()
--   submit_rally_answer(uuid,text,integer)
--   continue_rally_after_reveal(uuid)
--   check_rally_location(uuid,double precision,double precision,double precision)
--   use_rally_station_hint(uuid)
-- Admin RPCs:
--   admin_get_answer_config(uuid,uuid)
--   admin_save_answer_config(uuid,uuid,jsonb,integer,text)
--   admin_set_route_status(uuid,text)
--   admin_create_route(text,text)
--
-- Legacy tables public.stations/public.route_questions remain only for migration history.
-- Restrictive RLS prevents player reads from those tables.
