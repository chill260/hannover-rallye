# Supabase setup for Hannover Rallye

The current app uses Supabase Auth, RLS and server-side RPCs. There is no demo/local fallback anymore.

## Accounts

Create and confirm these users in **Authentication -> Users**:

- `team-a@rallye.example`
- `team-b@rallye.example`
- `orga@rallye.example`

The app itself asks only for `team-a`, `team-b` or `orga` plus the password.

## Browser configuration

`config.js` contains only:

- Supabase project URL
- Supabase publishable key
- login domain

Never put a secret key or service-role key in the repository.

## Current architecture

The route is versioned:

- one `published` route is played by the teams
- one `draft` route is edited by the organizer
- older versions become `archived`

Stations use stable UUIDs plus a separate `sort_order`. Questions point to station UUIDs rather than array indexes, so stations can be reordered without breaking references.

## Security model

Players cannot directly read route tables or the private answer configuration. The browser receives only the currently active question or travel clue through `get_rally_player_state()`.

Answers are checked server-side by `submit_rally_answer(...)`. Accepted free-text answers, correct multiple-choice indexes and solutions are stored in `private.rally_question_secrets`.

GPS is also checked server-side. The browser sends the current coordinates to `check_rally_location(...)`; raw coordinates are not persisted.

Direct player writes to run/progress tables are blocked by restrictive RLS. Progress changes happen through authenticated RPCs.

Organizer-only RPCs verify the admin role internally before accessing secrets or route-version controls.

## Main tables

- `profiles`
- `rally_routes`
- `rally_stations`
- `rally_questions`
- `rally_team_runs`
- `rally_team_station_progress`
- `rally_team_question_progress`
- `private.rally_question_secrets`

The older `stations`, `route_questions`, `team_progress` and related tables are retained only for migration/history and are no longer used by the current frontend.
