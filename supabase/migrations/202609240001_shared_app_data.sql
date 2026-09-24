-- Shared association data lives in Supabase Postgres so it survives Render's
-- free service restarts. These tables are accessed only by the Node API using
-- SUPABASE_SERVICE_ROLE_KEY; never place that key in the browser.

alter table public.profiles
  add column if not exists paid_month text not null default '',
  add column if not exists photo text not null default '';

create table if not exists public.settings (
  key text primary key,
  value text not null
);

create table if not exists public.app_state (
  id smallint primary key check (id = 1),
  state_json jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.baba_attendance (
  id uuid primary key default gen_random_uuid(),
  game_day date not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('presence', 'checkin')),
  created_at timestamptz not null default now(),
  unique (game_day, user_id, kind)
);

create table if not exists public.baba_votes (
  id uuid primary key default gen_random_uuid(),
  game_day date not null,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  player_email text not null,
  attr_key text not null check (attr_key in ('rit', 'dri', 'chu', 'def', 'pas', 'fis')),
  stars smallint not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  unique (game_day, voter_id, player_email, attr_key)
);

create table if not exists public.baba_matches (
  id text primary key,
  game_day date not null,
  game_data jsonb not null,
  voting_open boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.settings enable row level security;
alter table public.app_state enable row level security;
alter table public.baba_attendance enable row level security;
alter table public.baba_votes enable row level security;
alter table public.baba_matches enable row level security;

revoke all on public.settings, public.app_state, public.baba_attendance, public.baba_votes, public.baba_matches from anon, authenticated;
grant all on public.settings, public.app_state, public.baba_attendance, public.baba_votes, public.baba_matches to service_role;
grant select, update on public.profiles to service_role;

create index if not exists baba_attendance_game_day_idx on public.baba_attendance (game_day);
create index if not exists baba_votes_game_day_idx on public.baba_votes (game_day);
create index if not exists baba_matches_game_day_idx on public.baba_matches (game_day desc, created_at desc);
