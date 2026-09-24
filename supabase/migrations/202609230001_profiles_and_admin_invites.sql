create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  name text not null,
  phone text not null default '',
  age integer not null default 0 check (age between 0 and 120),
  position text not null default 'Meio-Campo',
  foot text not null default 'Direita',
  height numeric(3,2) not null default 1.70 check (height between 1.20 and 2.30),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace function public.create_futmancos_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name, phone, age, position, foot, height)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'age', '')::integer, 0),
    coalesce(nullif(new.raw_user_meta_data ->> 'position', ''), 'Meio-Campo'),
    coalesce(nullif(new.raw_user_meta_data ->> 'foot', ''), 'Direita'),
    coalesce(nullif(new.raw_user_meta_data ->> 'height', '')::numeric, 1.70)
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_futmancos on auth.users;
create trigger on_auth_user_created_futmancos
  after insert on auth.users
  for each row execute function public.create_futmancos_profile();

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (name, phone, age, position, foot, height) on public.profiles to authenticated;
drop policy if exists "Players can read own profile" on public.profiles;
create policy "Players can read own profile" on public.profiles for select to authenticated using ((select auth.uid()) = id);
drop policy if exists "Players can update own profile fields" on public.profiles;
create policy "Players can update own profile fields" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create table if not exists public.admin_code_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  attempts integer not null default 0,
  blocked_until timestamptz
);
alter table public.admin_code_attempts enable row level security;
revoke all on public.admin_code_attempts from anon, authenticated;

create or replace function public.promote_futmancos_admin(p_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  attempt_count integer;
  blocked_time timestamptz;
begin
  if current_user_id is null then return false; end if;
  insert into public.admin_code_attempts (user_id) values (current_user_id) on conflict (user_id) do nothing;
  select attempts, blocked_until into attempt_count, blocked_time
  from public.admin_code_attempts where user_id = current_user_id for update;
  if blocked_time is not null and blocked_time > now() then return false; end if;

  if p_code is distinct from '8630' then
    update public.admin_code_attempts
      set attempts = attempt_count + 1,
          blocked_until = case when attempt_count + 1 >= 5 then now() + interval '30 minutes' else null end
      where user_id = current_user_id;
    return false;
  end if;

  update public.profiles set is_admin = true where id = current_user_id;
  if not found then return false; end if;
  update public.admin_code_attempts set attempts = 0, blocked_until = null where user_id = current_user_id;
  return true;
end;
$$;
revoke all on function public.promote_futmancos_admin(text) from public, anon;
grant execute on function public.promote_futmancos_admin(text) to authenticated;
