create table if not exists public.member_guest_codes (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  code char(6) not null unique check (code ~ '^[0-9]{6}$'),
  created_at timestamptz not null default now()
);

create or replace function public.assign_member_guest_invitation_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare candidate text;
begin
  loop
    candidate := (100000 + floor(random() * 900000))::integer::text;
    begin
      insert into public.member_guest_codes(member_id, code) values (new.id, candidate);
      return new;
    exception when unique_violation then
      if exists (select 1 from public.member_guest_codes where member_id = new.id) then return new; end if;
    end;
  end loop;
end;
$$;

drop trigger if exists profiles_guest_invitation_code on public.profiles;
create trigger profiles_guest_invitation_code
after insert on public.profiles
for each row execute function public.assign_member_guest_invitation_code();

do $$
declare member_row record; candidate text;
begin
  for member_row in select id from public.profiles where id not in (select member_id from public.member_guest_codes) loop
    loop
      candidate := (100000 + floor(random() * 900000))::integer::text;
      begin
        insert into public.member_guest_codes(member_id, code) values (member_row.id, candidate);
        exit;
      exception when unique_violation then
        if exists (select 1 from public.member_guest_codes where member_id = member_row.id) then exit; end if;
      end;
    end loop;
  end loop;
end;
$$;

create table if not exists public.baba_draws (
  id text primary key,
  game_day date not null,
  draw_order integer not null,
  selected_count integer not null check (selected_count between 2 and 30),
  draw_data jsonb not null,
  finalized boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (game_day, draw_order)
);

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_deliveries (
  event_key text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delivered_at timestamptz not null default now(),
  primary key (event_key, user_id)
);

alter table public.member_guest_codes enable row level security;
alter table public.baba_draws enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_deliveries enable row level security;
revoke all on public.member_guest_codes, public.baba_draws, public.push_subscriptions, public.notification_deliveries from anon, authenticated;
grant all on public.member_guest_codes, public.baba_draws, public.push_subscriptions, public.notification_deliveries to service_role;

create index if not exists baba_draws_game_day_idx on public.baba_draws (game_day, draw_order);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
