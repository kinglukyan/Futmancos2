alter table public.profiles
  add column if not exists nickname text not null default '';

alter table public.profiles
  drop constraint if exists profiles_nickname_length_check;

alter table public.profiles
  add constraint profiles_nickname_length_check
  check (char_length(nickname) <= 24);

grant update (name, nickname, phone, age, position, foot, height, shirt_number)
  on public.profiles to authenticated;

create or replace function public.create_futmancos_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  signup_answer text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'association_answer', '')));
  signup_cpf text := regexp_replace(coalesce(new.raw_user_meta_data ->> 'cpf', ''), '[^0-9]', '', 'g');
  emergency_name text := btrim(coalesce(new.raw_user_meta_data ->> 'emergency_contact_name', ''));
  emergency_phone text := btrim(coalesce(new.raw_user_meta_data ->> 'emergency_contact_phone', ''));
  player_name text := btrim(coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)));
  player_nickname text := left(btrim(coalesce(new.raw_user_meta_data ->> 'nickname', '')), 24);
begin
  if signup_answer <> 'isaac' then
    raise exception 'Resposta de validação da associação incorreta.' using errcode = '23514';
  end if;
  if length(signup_cpf) <> 11 or signup_cpf !~ '^[0-9]{11}$' then
    raise exception 'Informe um CPF válido.' using errcode = '23514';
  end if;
  if emergency_name = '' or emergency_phone = '' then
    raise exception 'Informe o nome e o telefone do contato de emergência.' using errcode = '23514';
  end if;

  insert into public.profiles (id, email, name, nickname, phone, age, position, foot, height, shirt_number, emergency_contact_name, emergency_contact_phone)
  values (
    new.id,
    lower(new.email),
    player_name,
    coalesce(nullif(player_nickname, ''), player_name),
    coalesce(new.raw_user_meta_data ->> 'phone', ''),
    coalesce(nullif(new.raw_user_meta_data ->> 'age', '')::integer, 0),
    coalesce(nullif(new.raw_user_meta_data ->> 'position', ''), 'Meio-Campo'),
    coalesce(nullif(new.raw_user_meta_data ->> 'foot', ''), 'Direita'),
    coalesce(nullif(new.raw_user_meta_data ->> 'height', '')::numeric, 1.70),
    coalesce(nullif(new.raw_user_meta_data ->> 'shirt_number', '')::smallint, 0),
    emergency_name,
    emergency_phone
  );
  return new;
end;
$$;
