# Supabase setup for Hannover Rallye

The live page currently keeps working in demo/local mode until `config.js` contains Supabase values.

## 1. Create a Supabase project

Create a project in Supabase.

## 2. Apply the schema

Open **SQL Editor** in Supabase and run the complete contents of `supabase-schema.sql`.

## 3. Create the three Auth users

Create these users manually in **Authentication -> Users** and set passwords of your choice:

- `team-a@rallye.example`
- `team-b@rallye.example`
- `orga@rallye.example`

Use confirmed users / auto-confirm. The app itself will only ask for the usernames:

- `team-a`
- `team-b`
- `orga`

Public self-registration is not required.

## 4. Configure the web app

Get the **Project URL** and **Publishable key** from Supabase and put them into `config.js`.

Never use a secret key or service-role key in this repository.

## Data stored

No raw GPS coordinates are persisted. The DB stores only:

- team
- current station
- number of checks/attempts
- whether a hint was used
- whether a station was completed
- completion timestamps

## Tables

- `profiles`: maps Supabase Auth users to Team A, Team B or admin
- `team_progress`: current team status / scoreboard
- `station_progress`: per-station attempts, hints and completion

Row Level Security ensures Team A can only change Team A and Team B can only change Team B. The `orga` account can inspect both.
