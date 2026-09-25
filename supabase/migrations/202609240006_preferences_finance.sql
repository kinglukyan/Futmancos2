alter table public.baba_guests
  add column if not exists payment_status text not null default 'pending' check (payment_status in ('pending', 'paid')),
  add column if not exists payment_amount numeric(10,2) not null default 0 check (payment_amount >= 0);

create table if not exists public.member_notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  preferences jsonb not null default '{"baba":true,"payments":true,"votes":true}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.member_notification_preferences enable row level security;
revoke all on public.member_notification_preferences from anon, authenticated;
grant all on public.member_notification_preferences to service_role;
