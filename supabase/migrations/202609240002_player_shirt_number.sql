alter table public.profiles
  add column if not exists shirt_number smallint not null default 0
  check (shirt_number between 0 and 99);

create or replace function public.create_futmancos_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name, phone, age, position, foot, height, shirt_number)
  values (
    new.id,
    lower(new.email),
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'age', '')::integer, 0),
    coalesce(nullif(new.raw_user_meta_data ->> 'position', ''), 'Meio-Campo'),
    coalesce(nullif(new.raw_user_meta_data ->> 'foot', ''), 'Direita'),
    coalesce(nullif(new.raw_user_meta_data ->> 'height', '')::numeric, 1.70),
    coalesce(nullif(new.raw_user_meta_data ->> 'shirt_number', '')::smallint, 0)
  );
  return new;
end;
$$;

grant update (name, phone, age, position, foot, height, shirt_number)
  on public.profiles to authenticated;
