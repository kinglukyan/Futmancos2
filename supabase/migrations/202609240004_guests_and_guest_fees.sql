create table if not exists public.baba_guests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 2 and 80),
  cpf_hash text not null unique,
  cpf_encrypted text not null,
  cpf_last4 char(4) not null,
  age smallint not null check (age between 1 and 120),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.baba_guest_attendance (
  id uuid primary key default gen_random_uuid(),
  game_day date not null,
  guest_id uuid not null references public.baba_guests(id) on delete cascade,
  kind text not null check (kind in ('presence', 'checkin')),
  marked_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (game_day, guest_id, kind)
);

alter table public.baba_guests enable row level security;
alter table public.baba_guest_attendance enable row level security;
revoke all on public.baba_guests, public.baba_guest_attendance from anon, authenticated;
grant all on public.baba_guests, public.baba_guest_attendance to service_role;

create index if not exists baba_guest_attendance_game_day_idx
  on public.baba_guest_attendance (game_day, guest_id);
create index if not exists baba_guests_invited_by_idx
  on public.baba_guests (invited_by, created_at desc);

insert into public.settings (key, value) values
  ('guest_daily_fee', '0'),
  ('keeper_event_fee', '0')
on conflict (key) do nothing;
